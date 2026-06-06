import * as PIXI from 'pixi.js';
import type { AudioEngine } from '../audio/AudioEngine';
import { TAU, clamp, lerp } from './util';

const POINTS = 144;
const RINGS = 5;
const COLORS = [0x22d3ee, 0xd946ef, 0xffffff, 0x7c5cff, 0x34d399];

interface RingState {
  g: PIXI.Graphics;
  radii: Float32Array;
  velocity: Float32Array;
  phase: number;
  offset: number;
  width: number;
  alpha: number;
}

export class LogoOverlayVisualizer {
  private app: PIXI.Application;
  private audio: AudioEngine;
  private root = new PIXI.Container();
  private rings: RingState[] = [];
  private glow = new PIXI.Graphics();
  private core = new PIXI.Graphics();
  private t = 0;
  private cx = 0;
  private cy = 0;
  private baseRadius = 120;
  private disposed = false;

  constructor(app: PIXI.Application, audio: AudioEngine) {
    this.app = app;
    this.audio = audio;
    this.app.stage.addChild(this.root);

    this.glow.blendMode = PIXI.BLEND_MODES.ADD;
    this.core.blendMode = PIXI.BLEND_MODES.ADD;
    this.root.addChild(this.glow);
    for (let i = 0; i < RINGS; i++) {
      const g = new PIXI.Graphics();
      g.blendMode = PIXI.BLEND_MODES.ADD;
      this.root.addChild(g);
      this.rings.push({
        g,
        radii: new Float32Array(POINTS).fill(1),
        velocity: new Float32Array(POINTS),
        phase: Math.random() * TAU,
        offset: i,
        width: 5.5 - i * 0.55,
        alpha: 0.9 - i * 0.12,
      });
    }
    this.root.addChild(this.core);
  }

  resize() {
    const { width, height } = this.app.screen;
    this.cx = width / 2;
    this.cy = height / 2;
    this.baseRadius = Math.max(42, Math.min(width, height) * 0.24);
  }

  update(dt: number) {
    if (this.disposed) return;
    this.t += dt;

    const b = this.audio.bands;
    const bass = clamp(b.bass * 1.35, 0, 1.6);
    const mids = clamp(b.mids * 1.2, 0, 1.2);
    const highs = clamp(b.highs * 1.15, 0, 1);
    const vol = clamp(b.volume * 1.45, 0, 1.4);
    const beat = this.audio.beat ? this.audio.beatStrength || 0.7 : 0;

    this.drawGlow(vol, bass);
    for (let i = 0; i < this.rings.length; i++) {
      this.updateRing(this.rings[i], i, dt, bass, mids, highs, beat);
    }
    this.drawCore(vol, bass, beat);
  }

  private updateRing(ring: RingState, ringIndex: number, dt: number, bass: number, mids: number, highs: number, beat: number) {
    const spec = this.audio.spectrum;
    const radius = this.baseRadius * (1 + ringIndex * 0.105 + bass * 0.055);
    const softness = 0.82 - ringIndex * 0.035;
    const tension = 40 + ringIndex * 8;
    const neighborPull = 22;
    const damping = 0.86;

    for (let i = 0; i < POINTS; i++) {
      const u = i / POINTS;
      const a = u * TAU;
      const mirror = u <= 0.5 ? u * 2 : (1 - u) * 2;
      const bin = Math.min(spec.length - 1, 4 + Math.floor(Math.pow(mirror, 1.45) * 230));
      const audioPush = (spec[bin] || 0) * (0.22 + ringIndex * 0.035);
      const liquid =
        Math.sin(a * (2 + ringIndex) + this.t * (0.7 + ringIndex * 0.08) + ring.phase) * 0.045 +
        Math.sin(a * (5 + ringIndex) - this.t * (1.0 + ringIndex * 0.11) + ring.phase * 0.7) * 0.026 +
        Math.sin(a * 9 + this.t * 0.42 + ring.offset) * 0.014;
      const target = 1 + liquid + audioPush + bass * (0.08 - ringIndex * 0.008) + mids * 0.035 + beat * 0.08;
      const left = ring.radii[(i - 1 + POINTS) % POINTS];
      const right = ring.radii[(i + 1) % POINTS];
      const accel = (target - ring.radii[i]) * tension + ((left + right) * 0.5 - ring.radii[i]) * neighborPull;
      ring.velocity[i] = (ring.velocity[i] + accel * dt) * damping;
      ring.radii[i] = clamp(ring.radii[i] + ring.velocity[i] * dt, 0.72, 1.65);
      ring.radii[i] = lerp(ring.radii[i], target, 0.018 * softness);
    }

    const color = COLORS[ringIndex % COLORS.length];
    const alpha = ring.alpha * (0.42 + volLike(bass, mids, highs) * 0.38);
    const g = ring.g;
    g.clear();
    this.drawSoftLoop(g, ring.radii, radius, color, ring.width + highs * 2.5, alpha * 0.28, true);
    this.drawSoftLoop(g, ring.radii, radius, color, Math.max(1.5, ring.width * 0.45), alpha, false);
  }

  private drawSoftLoop(g: PIXI.Graphics, radii: Float32Array, radius: number, color: number, width: number, alpha: number, halo: boolean) {
    const scale = halo ? 1.012 : 1;
    g.lineStyle({ width, color, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
    let prevX = 0;
    let prevY = 0;
    let firstMidX = 0;
    let firstMidY = 0;

    const point = (i: number) => {
      const idx = i % POINTS;
      const a = (idx / POINTS) * TAU - Math.PI / 2;
      const r = radius * radii[idx] * scale;
      return { x: this.cx + Math.cos(a) * r, y: this.cy + Math.sin(a) * r };
    };

    const first = point(0);
    const last = point(POINTS - 1);
    firstMidX = (last.x + first.x) * 0.5;
    firstMidY = (last.y + first.y) * 0.5;
    g.moveTo(firstMidX, firstMidY);
    prevX = first.x;
    prevY = first.y;

    for (let i = 1; i <= POINTS; i++) {
      const p = point(i);
      const midX = (prevX + p.x) * 0.5;
      const midY = (prevY + p.y) * 0.5;
      g.quadraticCurveTo(prevX, prevY, midX, midY);
      prevX = p.x;
      prevY = p.y;
    }
    g.closePath();
  }

  private drawGlow(vol: number, bass: number) {
    const g = this.glow;
    const r = this.baseRadius * (1.05 + bass * 0.18);
    g.clear();
    for (let i = 4; i >= 0; i--) {
      g.lineStyle({
        width: 18 + i * 16,
        color: COLORS[i % COLORS.length],
        alpha: (0.025 + vol * 0.02) * (i + 1),
      });
      g.drawCircle(this.cx, this.cy, r + i * 4);
    }
  }

  private drawCore(vol: number, bass: number, beat: number) {
    const g = this.core;
    const r = this.baseRadius * (0.19 + bass * 0.04 + beat * 0.035);
    g.clear();
    g.beginFill(0xffffff, 0.2 + vol * 0.22);
    g.drawCircle(this.cx, this.cy, r);
    g.endFill();
    g.lineStyle({ width: 2, color: 0xffffff, alpha: 0.55 + vol * 0.25 });
    g.drawCircle(this.cx, this.cy, r * 1.25);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.root.parent) this.root.parent.removeChild(this.root);
    this.root.destroy({ children: true });
    this.rings = [];
  }
}

function volLike(bass: number, mids: number, highs: number) {
  return clamp(bass * 0.45 + mids * 0.35 + highs * 0.2, 0, 1.4);
}
