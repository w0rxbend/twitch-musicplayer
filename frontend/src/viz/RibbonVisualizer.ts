/* RibbonVisualizer.ts — smooth filled waveform blob.
 *
 * The soft organic style from the reference sheet: a single closed shape,
 * mirrored about the centre line, filled with a gradient running left to right.
 * Where the bar scenes are staccato, this one is legato — heavy smoothing both
 * across the display and over time, so the shape flows rather than flickers.
 */
import * as PIXI from 'pixi.js';
import type { AudioFrame } from './types';
import { WaveScene, type WaveSceneOptions } from './WaveScene';
import { rampByName, type Ramp } from './palette';
import type { AudioEngine } from '../audio/AudioEngine';

const POINTS = 96;
// How many neighbours each point is averaged with. Higher is smoother.
const SMOOTH_RADIUS = 3;

interface Pt { x: number; y: number }

export class RibbonVisualizer extends WaveScene {
  private ramp: Ramp;
  private level = new Float32Array(POINTS);
  private gradient: PIXI.FillGradient | null = null;

  constructor(app: PIXI.Application, audio: AudioEngine, options: WaveSceneOptions = {}) {
    super(app, audio, options, {
      wavePoints: POINTS,
      bands: 40,
      bloom: 1.1,
      bandHeight: 0.28,
    });
    this.ramp = rampByName(options.ramp ?? 'NEON');
  }

  protected onResize() {
    // Gradient stops live in global pixel space, so this is rebuilt whenever
    // the display size changes.
    try {
      this.gradient = new PIXI.FillGradient({
        type: 'linear',
        start: { x: this.marginX, y: this.cy },
        end: { x: this.W - this.marginX, y: this.cy },
        textureSpace: 'global',
        colorStops: this.ramp.cssStops(10, 0.82),
      });
    } catch {
      this.gradient = null; // fall back to a flat fill
    }
  }

  protected draw(frame: AudioFrame, dt: number) {
    const g = this.gfx;
    const usable = this.W - this.marginX * 2;
    const step = usable / (POINTS - 1);
    const amp = this.halfBand * (1 + this.beatPulse * 0.10);

    // Time smoothing first.
    const a = 1 - Math.exp(-dt / 0.10);
    for (let i = 0; i < POINTS; i++) {
      const target = Math.min(1, frame.waveRms[i] * 2.4);
      this.level[i] += (target - this.level[i]) * a;
    }

    // Then spatial smoothing, which is what turns a spiky waveform into a blob.
    const shaped: number[] = [];
    for (let i = 0; i < POINTS; i++) {
      let sum = 0;
      let weight = 0;
      for (let k = -SMOOTH_RADIUS; k <= SMOOTH_RADIUS; k++) {
        const j = i + k;
        if (j < 0 || j >= POINTS) continue;
        // Triangular weighting: nearer neighbours count for more.
        const w = SMOOTH_RADIUS + 1 - Math.abs(k);
        sum += this.level[j] * w;
        weight += w;
      }
      const t = i / (POINTS - 1);
      const window = Math.pow(Math.sin(Math.PI * t), 0.7);
      shaped.push((sum / weight) * window);
    }

    const top: Pt[] = [];
    const bottom: Pt[] = [];
    for (let i = 0; i < POINTS; i++) {
      const x = this.marginX + i * step;
      const h = Math.max(1, shaped[i] * amp);
      top.push({ x, y: this.cy - h });
      bottom.push({ x, y: this.cy + h });
    }

    // One closed path: along the top, back along the mirrored bottom.
    g.moveTo(top[0].x, top[0].y);
    curveThrough(g, top);
    g.lineTo(bottom[POINTS - 1].x, bottom[POINTS - 1].y);
    curveThrough(g, [...bottom].reverse());
    g.closePath();
    g.fill(this.gradient ?? { color: this.ramp.hex(0.5), alpha: 0.8 });

    // Crisp outline on the upper and lower edges.
    for (const edge of [top, bottom]) {
      g.moveTo(edge[0].x, edge[0].y);
      curveThrough(g, edge);
      g.stroke({ color: 0xffffff, alpha: 0.45, width: 1.6 });
    }
  }
}

/**
 * Draws a smooth curve through the points using midpoint quadratics: each
 * control point is a sample, and the curve passes through the midpoints
 * between them. Cheap, stable, and free of the overshoot a spline would add.
 */
function curveThrough(g: PIXI.Graphics, pts: Pt[]) {
  if (pts.length < 2) return;
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    g.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  g.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
}
