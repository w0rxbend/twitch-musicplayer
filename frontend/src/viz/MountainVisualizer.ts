import * as PIXI from 'pixi.js';
import { noise2d } from './noise';
import type { AudioFrame } from './types';

interface MountainLayer {
  bodyColor: number;
  glowColor: number;
  baseY: number;        // fraction of screenH
  amplitude: number;    // fraction of screenH
  noiseFreq: number;
  noiseSpeed: number;
  audioReact: number;   // bass multiplier
  glowWidth: number;
  glowAlpha: number;
  phase: number;
  graphics: PIXI.Graphics;
}

const LAYER_DEFS = [
  { bodyColor: 0x07070f, glowColor: 0x74c7ec, baseY: 0.60, amplitude: 0.06, noiseFreq: 1.2, noiseSpeed: 0.025, audioReact: 0.04, glowWidth: 1.5, glowAlpha: 0.35 },
  { bodyColor: 0x0b0b1a, glowColor: 0xb4befe, baseY: 0.67, amplitude: 0.08, noiseFreq: 1.8, noiseSpeed: 0.040, audioReact: 0.06, glowWidth: 2.0, glowAlpha: 0.45 },
  { bodyColor: 0x101028, glowColor: 0xcba6f7, baseY: 0.74, amplitude: 0.10, noiseFreq: 2.4, noiseSpeed: 0.060, audioReact: 0.09, glowWidth: 2.5, glowAlpha: 0.55 },
  { bodyColor: 0x161636, glowColor: 0x89dceb, baseY: 0.81, amplitude: 0.11, noiseFreq: 3.0, noiseSpeed: 0.080, audioReact: 0.12, glowWidth: 3.0, glowAlpha: 0.65 },
] as const;

const N_CTRL = 16;

function bezierCPs(pts: {x:number,y:number}[], i: number, t = 0.4) {
  const p0 = pts[Math.max(0, i - 2)];
  const p1 = pts[i - 1];
  const p2 = pts[i];
  const p3 = pts[Math.min(pts.length - 1, i + 1)];
  return {
    cp1x: p1.x + (p2.x - p0.x) * t / 3,
    cp1y: p1.y + (p2.y - p0.y) * t / 3,
    cp2x: p2.x - (p3.x - p1.x) * t / 3,
    cp2y: p2.y - (p3.y - p1.y) * t / 3,
  };
}

export class MountainVisualizer {
  readonly container = new PIXI.Container();
  private layers: MountainLayer[] = [];
  private pts: {x:number,y:number}[][] = [];
  private time = 0;
  private w = 0;
  private h = 0;

  constructor() {
    for (const def of LAYER_DEFS) {
      const graphics = new PIXI.Graphics();
      this.container.addChild(graphics);
      this.layers.push({ ...def, phase: Math.random() * 100, graphics });
      this.pts.push(Array.from({ length: N_CTRL }, () => ({ x: 0, y: 0 })));
    }
  }

  resize(w: number, h: number) {
    this.w = w; this.h = h;
  }

  update(dt: number, frame: AudioFrame) {
    this.time += dt;
    const { w, h, time } = this;
    if (w === 0) return;

    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li];
      const pts = this.pts[li];
      const audioOffset = frame.bass * layer.audioReact * h
                        + frame.lowMid * layer.audioReact * 0.4 * h;

      for (let i = 0; i < N_CTRL; i++) {
        const xNorm = (i / (N_CTRL - 1)) * 1.1 - 0.05;
        const nx = noise2d(xNorm * layer.noiseFreq + layer.phase, time * layer.noiseSpeed);
        const ny = noise2d(xNorm * layer.noiseFreq * 0.5, time * layer.noiseSpeed * 0.6 + 50);
        pts[i].x = xNorm * w;
        pts[i].y = layer.baseY * h
                 - (nx * 0.5 + 0.5) * layer.amplitude * h
                 - (ny * 0.3) * layer.amplitude * 0.5 * h
                 - audioOffset;
      }

      const g = layer.graphics;
      g.clear();

      // Body fill — solid silhouette
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const cp = bezierCPs(pts, i);
        g.bezierCurveTo(cp.cp1x, cp.cp1y, cp.cp2x, cp.cp2y, pts[i].x, pts[i].y);
      }
      g.lineTo(w * 1.05, h * 1.02);
      g.lineTo(-w * 0.05, h * 1.02);
      g.closePath();
      g.fill({ color: layer.bodyColor });

      // Peak glow stroke
      const glowAlpha = layer.glowAlpha + frame.bass * 0.2;
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const cp = bezierCPs(pts, i);
        g.bezierCurveTo(cp.cp1x, cp.cp1y, cp.cp2x, cp.cp2y, pts[i].x, pts[i].y);
      }
      g.stroke({ color: layer.glowColor, width: layer.glowWidth, alpha: glowAlpha });
    }
  }
}
