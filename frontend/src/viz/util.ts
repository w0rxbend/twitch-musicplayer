import * as PIXI from 'pixi.js';

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;

export const hexNum = (hex: string): number =>
  parseInt(String(hex).replace('#', ''), 16);

export const toRgb = (num: number) => ({
  r: (num >> 16) & 255,
  g: (num >> 8) & 255,
  b: num & 255,
});

export const mixNum = (a: number, b: number, t: number): number => {
  const ca = toRgb(a), cb = toRgb(b);
  const r = Math.round(lerp(ca.r, cb.r, t));
  const g = Math.round(lerp(ca.g, cb.g, t));
  const bl = Math.round(lerp(ca.b, cb.b, t));
  return (r << 16) | (g << 8) | bl;
};

export const hsl = (h: number, s: number, l: number): number => {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
};

export const gradientTexture = (top: number, bottom: number): PIXI.Texture => {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  const t = toRgb(top), b = toRgb(bottom);
  g.addColorStop(0, `rgb(${t.r},${t.g},${t.b})`);
  g.addColorStop(1, `rgb(${b.r},${b.g},${b.b})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  return PIXI.Texture.from(c);
};

export const radialTexture = (size = 256, hardness = 0.0): PIXI.Texture => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, r * hardness, r, r, r);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, TAU);
  ctx.fill();
  return PIXI.Texture.from(c);
};

export const sparkTexture = (size = 64): PIXI.Texture => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const r = size / 2;
  ctx.translate(r, r);
  const grad = (len: number, wid: number) => {
    const g = ctx.createLinearGradient(-len, 0, len, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-len, -wid, len * 2, wid * 2);
  };
  grad(r, r * 0.06);
  ctx.rotate(Math.PI / 2);
  grad(r, r * 0.06);
  ctx.rotate(-Math.PI / 2);
  const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.5);
  cg.addColorStop(0, 'rgba(255,255,255,0.9)');
  cg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.5, 0, TAU);
  ctx.fill();
  return PIXI.Texture.from(c);
};
