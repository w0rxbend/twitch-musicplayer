import * as PIXI from 'pixi.js';
import type { AudioFrame } from './types';

const SKY_STOPS: [number, string][] = [
  [0,    '#060610'],
  [0.40, '#0d0d22'],
  [0.72, '#151530'],
  [1,    '#1e1e2e'],
];

const FOG_CONFIGS = [
  { color: 0x1a1040, x: 0.20, y: 0.38, scale: 3.0, alpha: 0.18, speed: 0.012 },
  { color: 0x0e0a30, x: 0.70, y: 0.30, scale: 2.6, alpha: 0.14, speed: 0.008 },
  { color: 0x12082a, x: 0.50, y: 0.55, scale: 4.0, alpha: 0.12, speed: 0.006 },
];

function makeSkyTexture(): PIXI.Texture {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 512;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  for (const [stop, color] of SKY_STOPS) g.addColorStop(stop, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 512);
  return PIXI.Texture.from(c);
}

function makeFogTexture(color: number): PIXI.Texture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const r = size / 2;
  const R = (color >> 16) & 255, G = (color >> 8) & 255, B = color & 255;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0,   `rgba(${R},${G},${B},0.55)`);
  g.addColorStop(0.4, `rgba(${R},${G},${B},0.15)`);
  g.addColorStop(1,   `rgba(${R},${G},${B},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return PIXI.Texture.from(c);
}

export class BackgroundRenderer {
  readonly container = new PIXI.Container();
  private sky: PIXI.Sprite;
  private fogSprites: Array<PIXI.Sprite & { cfg: typeof FOG_CONFIGS[0] }> = [];
  private horizonGlow = new PIXI.Graphics();
  private time = 0;
  private w = 0;
  private h = 0;

  constructor() {
    this.sky = new PIXI.Sprite(makeSkyTexture());
    this.container.addChild(this.sky);

    for (const cfg of FOG_CONFIGS) {
      const sprite = Object.assign(new PIXI.Sprite(makeFogTexture(cfg.color)), { cfg });
      sprite.anchor.set(0.5);
      sprite.blendMode = 'screen';
      this.fogSprites.push(sprite);
      this.container.addChild(sprite);
    }

    this.container.addChild(this.horizonGlow);
  }

  resize(w: number, h: number) {
    this.w = w; this.h = h;
    this.sky.width = w;
    this.sky.height = h;
  }

  update(dt: number, frame: AudioFrame) {
    this.time += dt;
    const t = this.time;

    for (const sprite of this.fogSprites) {
      const { cfg } = sprite;
      const drift = Math.sin(t * cfg.speed + cfg.x * 10) * 0.04;
      sprite.position.set(
        this.w * (cfg.x + drift),
        this.h * (cfg.y + Math.sin(t * cfg.speed * 0.7) * 0.02),
      );
      sprite.scale.set(cfg.scale + frame.rms * 0.4);
      sprite.alpha = cfg.alpha + frame.rms * 0.06;
    }

    // Horizon pulse — bass-driven glow behind the mountains
    const horizonY = this.h * 0.60;
    const glowH = 80 + frame.bass * 60;
    const glowAlpha = 0.04 + frame.bass * 0.12;
    const g = this.horizonGlow;
    g.clear();
    g.rect(0, horizonY - glowH * 0.5, this.w, glowH);
    g.fill({ color: 0x2a1060, alpha: glowAlpha });
  }
}
