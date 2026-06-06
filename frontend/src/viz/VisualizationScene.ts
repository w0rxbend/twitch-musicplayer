/**
 * VisualizationScene — all 6 soundtools layers in one scene.
 *
 * Render space: 1920 × 1080  (CSS scales the canvas to viewport)
 * Layers (back → front):
 *   bgGlow · lavaBlobs · radialBars · elasticRings · ringBlob
 *   · beatRings · centerFill · waveform · centerBorder · particles · beatFlash
 */
import * as PIXI from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters';
import { noise2d } from './noise';
import type { AudioFrame } from './types';

// ── Constants (1920 × 1080 render space) ─────────────────
const CX = 960, CY = 475;         // visualizer center
const CENTER_R   = 146;            // black center circle
const WAVE_R     = 108;            // oscilloscope ring base radius
const RINGBLOB_R = 150;            // ring-blob equilibrium
const INNER_R    = 162;            // radial bar inner edge
const MAX_BAR_H  = 130;            // radial bar max length
const BAR_W      = 2.75;           // radial bar stroke width
const RING_SPD   = 320;            // beat ring expansion px/s
const N_RING_PTS = 256;            // points on each elastic ring
const N_BLOB_PTS = 128;            // points on ring blob
const N_BARS     = 256;
const N_PARTS    = 200;
const TRAIL_LEN  = 9;
const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

// Catppuccin Mocha accents
const CAT = {
  lavender: 0xb4befe, mauve:    0xcba6f7, sapphire: 0x74c7ec,
  pink:     0xf38ba8, sky:      0x89dceb, teal:     0x94e2d5,
};

type FreqBand = 'bass' | 'lowMid' | 'mid' | 'highMid' | 'treble';

// ── Elastic ring definitions ──────────────────────────────
interface RingDef {
  baseR:     number; thickness: number;
  color:     number; alpha:     number;
  stiffness: number; damping:   number;
  band:      FreqBand;
  amplitude: number; rotSpeed:  number;
  specLo:    number; specHi:    number;
}

const RING_DEFS: RingDef[] = [
  { baseR: 272, thickness: 4,   color: CAT.teal,     alpha: 0.82, stiffness: 160, damping: 11, band: 'bass',    amplitude: 35, rotSpeed:  0.040, specLo:   0, specHi:  50 },
  { baseR: 248, thickness: 3.5, color: CAT.pink,     alpha: 0.80, stiffness: 185, damping: 13, band: 'bass',    amplitude: 28, rotSpeed: -0.060, specLo:  30, specHi: 100 },
  { baseR: 228, thickness: 3,   color: CAT.mauve,    alpha: 0.80, stiffness: 210, damping: 15, band: 'lowMid',  amplitude: 24, rotSpeed:  0.080, specLo:  80, specHi: 200 },
  { baseR: 208, thickness: 3,   color: CAT.lavender, alpha: 0.80, stiffness: 240, damping: 17, band: 'mid',     amplitude: 20, rotSpeed: -0.100, specLo: 160, specHi: 300 },
  { baseR: 188, thickness: 2.5, color: CAT.sapphire, alpha: 0.78, stiffness: 275, damping: 19, band: 'highMid', amplitude: 17, rotSpeed:  0.120, specLo: 250, specHi: 380 },
  { baseR: 170, thickness: 2,   color: CAT.sky,      alpha: 0.75, stiffness: 310, damping: 22, band: 'treble',  amplitude: 14, rotSpeed: -0.160, specLo: 330, specHi: 511 },
];

// ── Lava blob definitions ─────────────────────────────────
const LAVA_BLOBS = [
  { orbitX: 48, orbitY: 36, sx: 0.38, sy: 0.29, phase: 0,    baseR: 68, color: 0x6d28d9 },
  { orbitX: 38, orbitY: 45, sx: 0.27, sy: 0.45, phase: 1.3,  baseR: 58, color: 0x9333ea },
  { orbitX: 42, orbitY: 32, sx: 0.52, sy: 0.36, phase: 2.6,  baseR: 52, color: 0xc026d3 },
  { orbitX: 50, orbitY: 40, sx: 0.32, sy: 0.27, phase: 3.9,  baseR: 60, color: 0x7c3aed },
  { orbitX: 30, orbitY: 48, sx: 0.46, sy: 0.42, phase: 5.2,  baseR: 64, color: 0xa855f7 },
  { orbitX: 45, orbitY: 28, sx: 0.61, sy: 0.51, phase: 0.8,  baseR: 49, color: 0xdb2777 },
];

// ── Internal state interfaces ─────────────────────────────
interface RingState { def: RingDef; disp: Float32Array; vel: Float32Array; rotation: number; nPhase: number; gfx: PIXI.Graphics }
interface BlobState { disp: Float32Array; vel: Float32Array; nPhase: number; gfx: PIXI.Graphics }
interface BeatRing  { r: number; alpha: number }
interface Particle  { angle: number; radius: number; baseR: number; radVel: number; angSpeed: number; size: number; alpha: number; color: number; nOff: number; trail: Array<{x:number;y:number}> }

// ── Background glow texture (radial gradient canvas) ──────
function makeGlowTexture(): PIXI.Texture {
  const sz = 512;
  const c  = document.createElement('canvas');
  c.width  = c.height = sz;
  const ctx = c.getContext('2d')!;
  const r   = sz / 2;
  const g   = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0,    'rgba(200,150,255,1)');
  g.addColorStop(0.30, 'rgba(140, 90,255,0.55)');
  g.addColorStop(0.65, 'rgba( 60, 20,180,0.12)');
  g.addColorStop(1,    'rgba(  0,  0,  0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, sz, sz);
  return PIXI.Texture.from(c);
}

// ── Main scene class ──────────────────────────────────────
export class VisualizationScene {
  private root = new PIXI.Container();

  private bgGlow: PIXI.Sprite;
  private lavaGfx        = new PIXI.Graphics();
  private radialWhite    = new PIXI.Graphics();
  private radialColor    = new PIXI.Graphics();
  private ringBlobGfx    = new PIXI.Graphics();
  private beatRingsGfx   = new PIXI.Graphics();
  private centerFillGfx  = new PIXI.Graphics();
  private waveGfx        = new PIXI.Graphics();
  private centerBorderGfx= new PIXI.Graphics();
  private particleGfx    = new PIXI.Graphics();
  private beatFlash      = new PIXI.Graphics();

  private ringStates: RingState[] = [];
  private blobState!: BlobState;
  private particles:  Particle[]  = [];
  private smoothBars  = new Float32Array(N_BARS);
  private beatRings:  BeatRing[]  = [];
  private beatPulse   = 0;
  private time        = 0;

  constructor(app: PIXI.Application) {
    // Background glow
    this.bgGlow = new PIXI.Sprite(makeGlowTexture());
    this.bgGlow.anchor.set(0.5);
    this.bgGlow.position.set(CX, CY);
    this.bgGlow.blendMode = 'screen';

    // Lava container — blur + screen blend creates atmospheric glow
    const lavaContainer = new PIXI.Container();
    lavaContainer.addChild(this.lavaGfx);
    try {
      lavaContainer.filters  = [new PIXI.BlurFilter({ strength: 18, quality: 3 })];
      lavaContainer.blendMode = 'screen';
    } catch { /* noop */ }

    // Radial bars container — bloom
    const radialContainer = new PIXI.Container();
    radialContainer.addChild(this.radialColor, this.radialWhite);
    try {
      radialContainer.filters = [
        new AdvancedBloomFilter({ threshold: 0.14, bloomScale: 1.9, brightness: 1, blur: 9, quality: 4 }),
      ];
    } catch { /* noop */ }

    // Elastic rings + ring blob container — bloom
    const ringsContainer = new PIXI.Container();
    ringsContainer.addChild(this.ringBlobGfx);
    for (const def of RING_DEFS) {
      const gfx = new PIXI.Graphics();
      ringsContainer.addChild(gfx);
      this.ringStates.push({
        def, gfx,
        disp: new Float32Array(N_RING_PTS),
        vel:  new Float32Array(N_RING_PTS),
        rotation: Math.random() * TAU,
        nPhase:   Math.random() * 100,
      });
    }
    this.blobState = {
      disp: new Float32Array(N_BLOB_PTS),
      vel:  new Float32Array(N_BLOB_PTS),
      nPhase: Math.random() * 100,
      gfx: this.ringBlobGfx,
    };
    try {
      ringsContainer.filters = [
        new AdvancedBloomFilter({ threshold: 0.14, bloomScale: 1.5, brightness: 1, blur: 9, quality: 4 }),
      ];
    } catch { /* noop */ }

    // Particle container — subtle bloom
    const particleContainer = new PIXI.Container();
    particleContainer.addChild(this.particleGfx);
    try {
      particleContainer.filters = [
        new AdvancedBloomFilter({ threshold: 0.32, bloomScale: 0.8, brightness: 1, blur: 5, quality: 3 }),
      ];
    } catch { /* noop */ }

    this.beatFlash.rect(0, 0, 1920, 1080).fill({ color: 0xffffff, alpha: 1 });
    this.beatFlash.alpha = 0;

    this.root.addChild(
      this.bgGlow,
      lavaContainer,
      radialContainer,
      ringsContainer,
      this.beatRingsGfx,
      this.centerFillGfx,
      this.waveGfx,
      this.centerBorderGfx,
      particleContainer,
      this.beatFlash,
    );
    app.stage.addChild(this.root);
    this.initParticles();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  resize(_w: number, _h: number) { /* fixed 1920×1080 */ }

  update(dt: number, frame: AudioFrame) {
    this.time += dt;

    this.updateSmoothing(frame);
    this.updateBeat(dt, frame);
    this.drawRadialBars(frame);
    this.updateElasticRings(dt, frame);
    this.updateRingBlob(dt, frame);
    this.drawLava(frame);
    this.drawBeatRings();
    this.drawCenter(frame);
    this.drawWaveform(frame);
    this.drawBgGlow(frame);
    this.updateParticles(dt, frame);
  }

  dispose() { this.root.destroy({ children: true }); }

  // ── Layer 1: Background glow ────────────────────────────
  private drawBgGlow(frame: AudioFrame) {
    this.bgGlow.scale.set(3.0 + frame.bass * 0.8 + this.beatPulse * 0.4);
    this.bgGlow.alpha   = 0.06 + frame.rms * 0.25 + this.beatPulse * 0.16;
  }

  // ── Layer 2: Lava lamp blobs ────────────────────────────
  private drawLava(frame: AudioFrame) {
    const t = this.time;
    this.lavaGfx.clear();
    for (const b of LAVA_BLOBS) {
      const bx = CX + Math.cos(t * b.sx + b.phase) * b.orbitX;
      const by = CY + Math.sin(t * b.sy + b.phase * 0.7) * b.orbitY;
      const shimmer = frame.treble * noise2d(t * 7 + b.phase, t * 5.3) * 6;
      const br = b.baseR + frame.bass * 28 + frame.rms * 14 + Math.sin(t * 1.6 + b.phase) * 7 + shimmer;
      for (const [mul, a] of [[2.5, 0.07], [1.8, 0.18], [1.3, 0.35], [1.0, 0.55]] as const) {
        this.lavaGfx.circle(bx, by, br * mul);
        this.lavaGfx.fill({ color: b.color, alpha: a });
      }
    }
  }

  // ── Layer 3: Radial bars ────────────────────────────────
  private drawRadialBars(frame: AudioFrame) {
    const boost = this.beatPulse * 28;
    this.radialWhite.clear();
    this.radialColor.clear();
    for (let i = 0; i < N_BARS; i++) {
      const angle = (i / N_BARS) * TAU - HALF_PI;
      const v     = this.smoothBars[i];
      const barH  = v * MAX_BAR_H + boost * v;
      if (barH < 0.5) continue;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const x0  = CX + cos * INNER_R,          y0 = CY + sin * INNER_R;
      const x1  = CX + cos * (INNER_R + barH), y1 = CY + sin * (INNER_R + barH);
      this.radialWhite.moveTo(x0, y0);
      this.radialWhite.lineTo(x1, y1);
      if (barH > 8) {
        this.radialColor.moveTo(CX + cos * (INNER_R + barH * 0.45), CY + sin * (INNER_R + barH * 0.45));
        this.radialColor.lineTo(x1, y1);
      }
    }
    this.radialWhite.stroke({ color: 0xffffff, width: BAR_W,       alpha: 0.93 });
    const tc = Math.min(frame.mid * 1.8, 1);
    const tipColor = (Math.round(168 - tc*130) << 16) | (Math.round(85 + tc*120) << 8) | Math.round(247 - tc*40);
    this.radialColor.stroke({ color: tipColor, width: BAR_W + 3.5, alpha: 0.26 });
  }

  // ── Layer 4: Elastic rings (spring physics) ─────────────
  private updateElasticRings(dt: number, frame: AudioFrame) {
    const t = this.time;
    for (const ring of this.ringStates) {
      ring.rotation += ring.def.rotSpeed * dt;
      const { def } = ring;
      const bandVal   = frame[def.band];
      const specRange = def.specHi - def.specLo;
      for (let i = 0; i < N_RING_PTS; i++) {
        const angle   = (i / N_RING_PTS) * TAU;
        const specBin = Math.min(def.specLo + Math.floor(i / N_RING_PTS * specRange), 511);
        const specVal = frame.spectrum[specBin] ?? 0;
        const nv      = noise2d(Math.cos(angle) * 2.5 + ring.nPhase, Math.sin(angle) * 2.5 + t * 0.28);
        const target  = bandVal * def.amplitude * 0.65
                      + specVal * def.amplitude * 0.45
                      + (nv * 0.5 + 0.5) * def.amplitude * 0.18;
        const force   = def.stiffness * (target - ring.disp[i]) - def.damping * ring.vel[i];
        ring.vel[i]  += force * dt;
        ring.disp[i] += ring.vel[i] * dt;
      }
      if (this.beatPulse > 0.05) {
        for (let i = 0; i < N_RING_PTS; i++) ring.vel[i] += this.beatPulse * 10 * dt;
      }
      this.drawRing(ring);
    }
  }

  private drawRing(ring: RingState) {
    const { def, gfx, rotation } = ring;
    gfx.clear();
    const alpha = def.alpha + this.beatPulse * 0.12;
    gfx.moveTo(CX + Math.cos(rotation) * (def.baseR + ring.disp[0]),
               CY + Math.sin(rotation) * (def.baseR + ring.disp[0]));
    for (let i = 1; i <= N_RING_PTS; i++) {
      const j = i % N_RING_PTS;
      const a = (j / N_RING_PTS) * TAU + rotation;
      const r = def.baseR + ring.disp[j];
      gfx.lineTo(CX + Math.cos(a) * r, CY + Math.sin(a) * r);
    }
    gfx.closePath();
    gfx.stroke({ color: def.color, width: def.thickness, alpha });
  }

  // ── Layer 4b: RingBlob (organic elastic membrane) ───────
  private updateRingBlob(dt: number, frame: AudioFrame) {
    const t   = this.time;
    const b   = this.blobState;
    const STF = 200, DMP = 16;
    for (let i = 0; i < N_BLOB_PTS; i++) {
      const angle  = (i / N_BLOB_PTS) * TAU;
      const bass   = frame.bass   * 20;
      const mid    = frame.mid    * 12 * Math.sin(angle * 4 + t * 1.5);
      const treble = frame.treble * noise2d(angle * 5 + b.nPhase, t * 2.8) * 8;
      const base   = noise2d(angle * 2.2 + b.nPhase, t * 0.35) * 10;
      const target = bass + mid + treble + base;
      const force  = STF * (target - b.disp[i]) - DMP * b.vel[i];
      b.vel[i]    += force * dt;
      b.disp[i]   += b.vel[i] * dt;
    }
    if (this.beatPulse > 0.04) {
      for (let i = 0; i < N_BLOB_PTS; i++) b.vel[i] += this.beatPulse * 18 * dt;
    }

    const g = b.gfx;
    g.clear();

    // Two passes: wide glow + crisp core
    for (let pass = 0; pass < 2; pass++) {
      g.moveTo(CX + Math.cos(0) * (RINGBLOB_R + b.disp[0]),
               CY + Math.sin(0) * (RINGBLOB_R + b.disp[0]));
      for (let i = 1; i <= N_BLOB_PTS; i++) {
        const j = i % N_BLOB_PTS;
        const a = (j / N_BLOB_PTS) * TAU;
        const r = RINGBLOB_R + b.disp[j];
        g.lineTo(CX + Math.cos(a) * r, CY + Math.sin(a) * r);
      }
      g.closePath();
      g.stroke(pass === 0
        ? { color: CAT.mauve, width: 18, alpha: 0.10 }
        : { color: CAT.mauve, width: 2.5, alpha: 0.80 + this.beatPulse * 0.15 });
    }
  }

  // ── Layer 5: Beat rings (expanding on beat) ─────────────
  private drawBeatRings() {
    this.beatRingsGfx.clear();
    for (const r of this.beatRings) {
      this.beatRingsGfx.circle(CX, CY, r.r);
      this.beatRingsGfx.stroke({ color: 0xffffff, width: 2, alpha: r.alpha });
    }
  }

  // ── Layer 6: Center circle (black fill + border) ─────────
  private drawCenter(frame: AudioFrame) {
    const pulse = CENTER_R + this.beatPulse * 10;
    this.centerFillGfx.clear();
    this.centerFillGfx.circle(CX, CY, pulse).fill({ color: 0x000000 });
    this.centerBorderGfx.clear();
    this.centerBorderGfx.circle(CX, CY, pulse).stroke({ color: 0xffffff, width: 2, alpha: 0.88 });
    this.centerBorderGfx.circle(CX, CY, pulse - 8).stroke({ color: 0xffffff, width: 0.8, alpha: 0.22 });
  }

  // ── Layer 7: Waveform oscilloscope (inside center) ────────
  private drawWaveform(frame: AudioFrame) {
    const td = frame.timeDomain;
    const N  = 128;
    const step = Math.floor(1024 / N);
    const maxD = 26;
    this.waveGfx.clear();
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * TAU;
      const r     = WAVE_R + td[i * step] * maxD;
      const x     = CX + Math.cos(angle) * r;
      const y     = CY + Math.sin(angle) * r;
      if (i === 0) this.waveGfx.moveTo(x, y); else this.waveGfx.lineTo(x, y);
    }
    this.waveGfx.closePath();
    this.waveGfx.stroke({ color: CAT.sapphire, width: 1.2, alpha: 0.42 + frame.rms * 0.38 });
  }

  // ── Layer 8: Sound particles with trails ─────────────────
  private updateParticles(dt: number, frame: AudioFrame) {
    const t = this.time;
    this.particleGfx.clear();
    for (const p of this.particles) {
      p.angle  += p.angSpeed * dt * (1 + frame.rms * 0.45);
      const nv  = noise2d(p.angle + p.nOff, t * 0.14) * 18;
      const tgt = p.baseR + nv + frame.rms * 30;
      p.radVel += (tgt - p.radius) * 8 * dt;
      p.radVel *= Math.exp(-6 * dt);
      p.radius += p.radVel * dt;
      if (frame.beat) p.radVel += frame.beatStrength * 60;

      // Treble sparkle
      const flicker = (frame.treble > 0.3 && Math.random() < frame.treble * 0.35) ? 0 : 1;

      const px = CX + Math.cos(p.angle) * p.radius;
      const py = CY + Math.sin(p.angle) * p.radius;
      p.trail.unshift({ x: px, y: py });
      if (p.trail.length > TRAIL_LEN) p.trail.pop();

      for (let j = 1; j < p.trail.length; j++) {
        const tr = p.trail[j];
        this.particleGfx.circle(tr.x, tr.y, p.size * (1 - j / TRAIL_LEN * 0.55));
        this.particleGfx.fill({ color: p.color, alpha: p.alpha * (1 - j / TRAIL_LEN) * 0.24 * flicker });
      }
      this.particleGfx.circle(px, py, p.size);
      this.particleGfx.fill({ color: p.color, alpha: Math.min(1, p.alpha * (0.7 + frame.rms * 0.7)) * flicker });
    }
  }

  // ── Helpers ───────────────────────────────────────────────
  private updateSmoothing(frame: AudioFrame) {
    for (let i = 0; i < N_BARS; i++) {
      const tgt = frame.spectrum[Math.min(i * 2, 511)];
      const α   = tgt > this.smoothBars[i] ? 0.68 : 0.09;
      this.smoothBars[i] = this.smoothBars[i] * (1 - α) + tgt * α;
    }
  }

  private updateBeat(dt: number, frame: AudioFrame) {
    if (frame.beat) {
      this.beatPulse = Math.min(1, this.beatPulse + frame.beatStrength * 0.9);
      if (this.beatRings.length < 5) this.beatRings.push({ r: CENTER_R + 5, alpha: 0.78 });
      this.beatFlash.alpha = frame.beatStrength * 0.055;
    }
    this.beatPulse       *= Math.exp(-9 * dt);
    this.beatFlash.alpha *= Math.exp(-16 * dt);
    for (const r of this.beatRings) { r.r += RING_SPD * dt; r.alpha -= 2.2 * dt; }
    this.beatRings = this.beatRings.filter(r => r.alpha > 0);
  }

  private initParticles() {
    const COLS = [0xffffff, 0xffffff, 0xd4b4fe, CAT.sky, CAT.teal, 0xc4b5fd];
    this.particles = [];
    for (let i = 0; i < N_PARTS; i++) {
      const baseR = 185 + Math.random() * 125; // 185–310 px; rings are 170-272
      this.particles.push({
        angle: Math.random() * TAU, radius: baseR, baseR, radVel: 0,
        angSpeed: (0.10 + Math.random() * 0.30) * (Math.random() < 0.5 ? 1 : -1),
        size: 1.2 + Math.random() * 2.0,
        alpha: 0.35 + Math.random() * 0.45,
        color: COLS[Math.floor(Math.random() * COLS.length)],
        nOff: Math.random() * 100,
        trail: [],
      });
    }
  }
}
