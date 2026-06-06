import * as PIXI from 'pixi.js';
import { noise2d } from './noise';
import type { AudioFrame } from './types';

const TAU = Math.PI * 2;
const N = 200;
const COLORS = [0x89dceb, 0x94e2d5, 0xb4befe, 0x74c7ec, 0xcba6f7];

interface Particle {
  angle: number;
  radius: number;
  baseRadius: number;
  radiusVel: number;
  angularSpeed: number;
  size: number;
  alpha: number;
  color: number;
  noiseOffset: number;
}

export class ParticleSystem {
  readonly container = new PIXI.Container();
  private graphics = new PIXI.Graphics();
  private particles: Particle[] = [];
  private cx = 0;
  private cy = 0;
  private h = 0;
  private time = 0;

  constructor() {
    this.container.addChild(this.graphics);
    this.container.alpha = 0.8;
  }

  resize(w: number, h: number) {
    this.cx = w / 2;
    this.cy = h * 0.42;
    this.h = h;
    this.initParticles(h);
  }

  private initParticles(h: number) {
    this.particles = [];
    for (let i = 0; i < N; i++) {
      const baseR = (0.13 + Math.random() * 0.22) * h;
      this.particles.push({
        angle: Math.random() * TAU,
        radius: baseR,
        baseRadius: baseR,
        radiusVel: 0,
        angularSpeed: (0.08 + Math.random() * 0.32) * (Math.random() < 0.5 ? 1 : -1),
        size: 0.8 + Math.random() * 1.8,
        alpha: 0.3 + Math.random() * 0.5,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        noiseOffset: Math.random() * 100,
      });
    }
  }

  update(dt: number, frame: AudioFrame) {
    this.time += dt;
    const { cx, cy, time } = this;
    if (this.h === 0) return;

    for (const p of this.particles) {
      p.angle += p.angularSpeed * dt * (1 + frame.rms * 0.5);

      const noiseR = noise2d(p.angle + p.noiseOffset, time * 0.18) * this.h * 0.012;
      const targetR = p.baseRadius + noiseR + frame.rms * this.h * 0.02;
      p.radiusVel += (targetR - p.radius) * 6 * dt;
      p.radiusVel *= Math.exp(-5 * dt);
      p.radius += p.radiusVel * dt;

      if (frame.beat) {
        p.radiusVel += frame.beatStrength * this.h * 0.025;
      }
    }

    const g = this.graphics;
    g.clear();
    for (const p of this.particles) {
      const x = cx + Math.cos(p.angle) * p.radius;
      const y = cy + Math.sin(p.angle) * p.radius;
      const alpha = p.alpha * (0.6 + frame.rms * 0.8);
      g.circle(x, y, p.size);
      g.fill({ color: p.color, alpha: Math.min(1, alpha) });
    }
  }
}
