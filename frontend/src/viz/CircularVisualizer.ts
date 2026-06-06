import * as PIXI from 'pixi.js';
import { noise2d } from './noise';
import type { AudioFrame } from './types';

const TAU = Math.PI * 2;
const N_PTS = 128;

type FreqBand = 'bass' | 'lowMid' | 'mid' | 'highMid' | 'treble';

interface RingDef {
  baseR: number;     // fraction of screenH
  thickness: number;
  glowWidth: number;
  amplitude: number; // fraction of screenH
  stiffness: number;
  damping: number;
  band: FreqBand;
  color: number;
  glowColor: number;
  alpha: number;
  glowAlpha: number;
  rotSpeed: number;  // rad/s
  specLo: number;    // spectrum bin range
  specHi: number;
}

const RING_DEFS: RingDef[] = [
  { baseR: 0.255, thickness: 2.5, glowWidth: 8,  amplitude: 0.065, stiffness: 160, damping: 11, band: 'bass',    color: 0xf38ba8, glowColor: 0xf38ba8, alpha: 0.75, glowAlpha: 0.14, rotSpeed:  0.04, specLo:  0, specHi: 50  },
  { baseR: 0.215, thickness: 2.0, glowWidth: 7,  amplitude: 0.055, stiffness: 185, damping: 13, band: 'lowMid',  color: 0xcba6f7, glowColor: 0xcba6f7, alpha: 0.78, glowAlpha: 0.16, rotSpeed: -0.06, specLo: 40, specHi: 160 },
  { baseR: 0.178, thickness: 1.8, glowWidth: 6,  amplitude: 0.045, stiffness: 210, damping: 15, band: 'mid',     color: 0xb4befe, glowColor: 0xb4befe, alpha: 0.82, glowAlpha: 0.18, rotSpeed:  0.08, specLo:130, specHi: 260 },
  { baseR: 0.143, thickness: 1.5, glowWidth: 5,  amplitude: 0.038, stiffness: 240, damping: 17, band: 'highMid', color: 0x74c7ec, glowColor: 0x74c7ec, alpha: 0.78, glowAlpha: 0.15, rotSpeed: -0.10, specLo:220, specHi: 380 },
  { baseR: 0.110, thickness: 1.2, glowWidth: 4,  amplitude: 0.028, stiffness: 290, damping: 20, band: 'treble',  color: 0x89dceb, glowColor: 0x89dceb, alpha: 0.72, glowAlpha: 0.12, rotSpeed:  0.14, specLo:330, specHi: 511 },
  { baseR: 0.072, thickness: 0.9, glowWidth: 3,  amplitude: 0.020, stiffness: 140, damping:  9, band: 'bass',    color: 0x94e2d5, glowColor: 0x94e2d5, alpha: 0.55, glowAlpha: 0.10, rotSpeed: -0.05, specLo:  0, specHi: 30  },
];

interface Ring {
  def: RingDef;
  disp: Float32Array;
  vel: Float32Array;
  rotation: number;
  noisePhase: number;
  graphics: PIXI.Graphics;
}

export class CircularVisualizer {
  readonly container = new PIXI.Container();
  private rings: Ring[] = [];
  private cx = 0;
  private cy = 0;
  private h = 0;
  private time = 0;
  private beatPulse = 0;

  constructor() {
    for (const def of RING_DEFS) {
      const g = new PIXI.Graphics();
      this.container.addChild(g);
      this.rings.push({
        def,
        disp: new Float32Array(N_PTS),
        vel: new Float32Array(N_PTS),
        rotation: Math.random() * TAU,
        noisePhase: Math.random() * 100,
        graphics: g,
      });
    }
  }

  resize(w: number, h: number) {
    this.cx = w / 2;
    this.cy = h * 0.42;
    this.h = h;
  }

  update(dt: number, frame: AudioFrame) {
    this.time += dt;
    const { cx, cy, h, time } = this;
    if (h === 0) return;

    if (frame.beat) {
      this.beatPulse = Math.min(1, this.beatPulse + frame.beatStrength * 0.6);
    }
    this.beatPulse *= Math.exp(-6 * dt);

    for (const ring of this.rings) {
      const { def } = ring;
      ring.rotation += def.rotSpeed * dt;

      const bandVal = frame[def.band];
      const baseRadius = def.baseR * h + this.beatPulse * def.baseR * h * 0.06;
      const specRange = def.specHi - def.specLo;

      for (let i = 0; i < N_PTS; i++) {
        const t = i / N_PTS;
        const angle = t * TAU;
        const specBin = Math.floor(def.specLo + (t * specRange));
        const specVal = frame.spectrum[Math.min(specBin, 511)] ?? 0;
        const nv = noise2d(
          Math.cos(angle) * 1.8 + ring.noisePhase,
          Math.sin(angle) * 1.8 + time * 0.25,
        );
        const target = bandVal * def.amplitude * h * 0.65
                     + specVal * def.amplitude * h * 0.45
                     + (nv * 0.5 + 0.5) * def.amplitude * h * 0.20;

        const force = def.stiffness * (target - ring.disp[i]) - def.damping * ring.vel[i];
        ring.vel[i] += force * dt;
        ring.disp[i] += ring.vel[i] * dt;
      }

      this.drawRing(ring, baseRadius, frame);
    }
  }

  private drawRing(ring: Ring, baseRadius: number, frame: AudioFrame) {
    const { def, graphics: g, rotation } = ring;
    g.clear();

    const alpha = def.alpha + frame.rms * 0.12;

    // Glow pass (wider, transparent stroke)
    g.moveTo(
      cx(0, N_PTS, baseRadius, ring, rotation, this.cx),
      cy(0, N_PTS, baseRadius, ring, rotation, this.cy),
    );
    for (let i = 1; i <= N_PTS; i++) {
      g.lineTo(
        cx(i % N_PTS, N_PTS, baseRadius, ring, rotation, this.cx),
        cy(i % N_PTS, N_PTS, baseRadius, ring, rotation, this.cy),
      );
    }
    g.closePath();
    g.stroke({ color: def.glowColor, width: def.glowWidth, alpha: def.glowAlpha });

    // Core ring
    g.moveTo(
      cx(0, N_PTS, baseRadius, ring, rotation, this.cx),
      cy(0, N_PTS, baseRadius, ring, rotation, this.cy),
    );
    for (let i = 1; i <= N_PTS; i++) {
      g.lineTo(
        cx(i % N_PTS, N_PTS, baseRadius, ring, rotation, this.cx),
        cy(i % N_PTS, N_PTS, baseRadius, ring, rotation, this.cy),
      );
    }
    g.closePath();
    g.stroke({ color: def.color, width: def.thickness, alpha });
  }
}

function cx(i: number, n: number, baseR: number, ring: Ring, rot: number, centerX: number): number {
  const angle = (i / n) * TAU + rot;
  return centerX + Math.cos(angle) * (baseR + ring.disp[i]);
}

function cy(i: number, n: number, baseR: number, ring: Ring, rot: number, centerY: number): number {
  const angle = (i / n) * TAU + rot;
  return centerY + Math.sin(angle) * (baseR + ring.disp[i]);
}
