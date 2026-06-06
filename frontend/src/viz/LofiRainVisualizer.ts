/* LofiRainVisualizer.ts — PIXI v8 port of the Lofi Rain Visualizer design.
   Layer order (back→front):
     bgLayer: sky · moon · clouds · fog · aurora · stars · mountains · city
              · reflection · rain-mid
     glowLayer (bloom): aura · shock · particles · fluid · bassRing · eq · wave
                        · coreWrap · comets · sparkles
     fgLayer: rain-fg

   Quality notes:
     - All spectrum data is pre-smoothed with a 7-tap Gaussian each frame before
       being mapped to geometry, eliminating raw-bin jagginess.
     - Every poly-line is drawn as quadratic midpoint curves (no raw lineTo edges).
     - All stroke() calls use cap:'round' and join:'round'.
     - Stage sets antialias:true and respects full devicePixelRatio (≤2×).
*/
import * as PIXI from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters';
import gsap from 'gsap';
import { lerp, clamp } from './util';
import type { AudioEngine } from '../audio/AudioEngine';

const TAU = Math.PI * 2;

// ── Colour helpers ────────────────────────────────────────────────────────────

function hexNum(hex: string): number {
  return parseInt(String(hex).replace('#', ''), 16);
}

function toRgb(n: number) {
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mixNum(a: number, b: number, t: number): number {
  const ca = toRgb(a), cb = toRgb(b);
  return (
    (Math.round(lerp(ca.r, cb.r, t)) << 16) |
    (Math.round(lerp(ca.g, cb.g, t)) << 8) |
     Math.round(lerp(ca.b, cb.b, t))
  );
}

// ── Texture factories ─────────────────────────────────────────────────────────

function gradientTexture(top: number, bot: number): PIXI.Texture {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  const t = toRgb(top), b = toRgb(bot);
  g.addColorStop(0, `rgb(${t.r},${t.g},${t.b})`);
  g.addColorStop(1, `rgb(${b.r},${b.g},${b.b})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  return PIXI.Texture.from(c);
}

function radialTexture(size = 256, hardness = 0): PIXI.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, r * hardness, r, r, r);
  g.addColorStop(0,    'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1,    'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(r, r, r, 0, TAU); ctx.fill();
  return PIXI.Texture.from(c);
}

function sparkTexture(size = 64): PIXI.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const r = size / 2;
  ctx.translate(r, r);
  const bar = (len: number, wid: number) => {
    const g = ctx.createLinearGradient(-len, 0, len, 0);
    g.addColorStop(0,   'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(1,   'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-len, -wid, len * 2, wid * 2);
  };
  bar(r, r * 0.06);
  ctx.rotate(Math.PI / 2); bar(r, r * 0.06); ctx.rotate(-Math.PI / 2);
  const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.5);
  cg.addColorStop(0, 'rgba(255,255,255,0.9)');
  cg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = cg;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.5, 0, TAU); ctx.fill();
  return PIXI.Texture.from(c);
}

function mkRainTex(): PIXI.Texture {
  const c = document.createElement('canvas');
  c.width = 6; c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0,   'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.85)');
  g.addColorStop(1,   'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(2, 0, 2, 64);
  return PIXI.Texture.from(c);
}

// ── Seeded RNG (Mulberry32) ───────────────────────────────────────────────────

function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Draw a smooth open polyline with midpoint quadratics ──────────────────────
// pts must have ≥2 entries. Leaves the current path open (caller decides stroke/fill).
function smoothPolyline(g: PIXI.Graphics, pts: ArrayLike<[number, number]>, len: number) {
  if (len < 2) return;
  g.moveTo((pts[0][0] + pts[1][0]) * 0.5, (pts[0][1] + pts[1][1]) * 0.5);
  for (let i = 1; i < len - 1; i++) {
    g.quadraticCurveTo(pts[i][0], pts[i][1],
      (pts[i][0] + pts[i + 1][0]) * 0.5,
      (pts[i][1] + pts[i + 1][1]) * 0.5);
  }
  g.lineTo(pts[len - 1][0], pts[len - 1][1]);
}

// Smooth open polyline from parallel Float32Array X/Y buffers (forward pass).
// Starts with a moveTo to the first midpoint; ends with lineTo to the exact last point.
function smoothLineXY(g: PIXI.Graphics, xs: Float32Array, ys: Float32Array, n: number) {
  if (n < 2) return;
  g.moveTo((xs[0] + xs[1]) * 0.5, (ys[0] + ys[1]) * 0.5);
  for (let i = 1; i < n - 1; i++) {
    g.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[i + 1]) * 0.5, (ys[i] + ys[i + 1]) * 0.5);
  }
  g.lineTo(xs[n - 1], ys[n - 1]);
}

// Appends the reverse pass (n-1 → 0) to the current path (no moveTo).
function smoothLineXYRev(g: PIXI.Graphics, xs: Float32Array, ys: Float32Array, n: number) {
  if (n < 2) return;
  // Step from current position to the start of the reverse smooth section
  g.lineTo((xs[n - 2] + xs[n - 1]) * 0.5, (ys[n - 2] + ys[n - 1]) * 0.5);
  for (let i = n - 2; i > 0; i--) {
    g.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[i - 1]) * 0.5, (ys[i] + ys[i - 1]) * 0.5);
  }
  g.lineTo(xs[0], ys[0]);
}

// Same but closed — for rings etc.
function smoothLoop(g: PIXI.Graphics, xs: Float32Array, ys: Float32Array, M: number, scale = 1) {
  g.moveTo((xs[M - 1] + xs[0]) * 0.5 * scale, (ys[M - 1] + ys[0]) * 0.5 * scale);
  for (let i = 0; i < M; i++) {
    const ni = (i + 1) % M;
    g.quadraticCurveTo(
      xs[i] * scale, ys[i] * scale,
      (xs[i] + xs[ni]) * 0.5 * scale, (ys[i] + ys[ni]) * 0.5 * scale,
    );
  }
  g.closePath();
}

// ── Interfaces ────────────────────────────────────────────────────────────────

interface Palette { primary: number; secondary: number; bgTop: number; bgBot: number; accent: number }
interface RainDrop { spr: PIXI.Sprite; vy: number; len: number; baseA: number }
interface StarItem  { spr: PIXI.Sprite; base: number; tw: number; ph: number; drift: number }
interface FogBlob   { spr: PIXI.Sprite; speed: number; baseA: number; baseY: number; bob: number; phase: number }
interface CloudItem { spr: PIXI.Sprite; speed: number; baseA: number }
interface CityItem  { spr: PIXI.Sprite; base: number; tw: number; ph: number }
interface ReflStreak { spr: PIXI.Sprite; row: number; wob: number; ph: number }
interface AuroraBand { col: number; baseY: number; amp: number; thick: number; fx: number; sp: number; a: number }
interface Shock     { r: number; a: number; w: number }
interface SparkItem { spr: PIXI.Sprite; ang: number; rad: number; vr: number; life: number; max: number; size: number }
interface CometItem { ang: number; r: number; v: number; life: number; max: number; len: number; col: number }
interface ShootItem { x: number; y: number; vx: number; vy: number; life: number; max: number; len: number; col: number }
// Lava-lamp blob: rises/sinks on a sinusoidal cycle whose speed is heated by bass
interface LavaBlob {
  spr:       PIXI.Sprite;
  phase:     number;   // position in vertical cycle (0..TAU)
  speed:     number;   // base phase advancement (rad/s)
  xCtr:      number;   // horizontal centre (fraction of R)
  xAmp:      number;   // horizontal drift amplitude (fraction of R)
  xFreq:     number;   // horizontal drift frequency
  xPh:       number;   // horizontal drift phase offset
  sz:        number;   // base size factor
  react:     number;   // bass-heat reactivity
}
interface Particle  { spr: PIXI.Sprite; ang0: number; rad: number; x: number | null; y: number | null; vx: number; vy: number; wAng: number; wTurn: number; wander: number; swirl: number; drag: number; react: number; base: number; size: number }
interface RidgeState { g: PIXI.Graphics; speed: number; dim: number }

interface LofiRainVisualizerOptions {
  showBackground?: boolean;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class LofiRainVisualizer {
  // config (mutable)
  intensity = 0.7;
  bassGain  = 0.85;
  bloomMul  = 0.85;
  fogMul    = 1;
  rainMul   = 1;
  cityOn    = true;
  reflOn    = true;

  private app:   PIXI.Application;
  private audio: AudioEngine;
  private showBackground: boolean;
  private t = 0;
  private _cycle  = 0;
  private _energy = 0;
  private _volS   = 0;
  private _bassS  = 0;
  private _beatPop = 0;
  private _bgFlash = 0;
  private _shootTimer = 0;
  private _attack = 0;

  // 7-tap Gaussian-smoothed spectrum (updated every frame before any drawing)
  private _smoothSpec = new Float32Array(512);
  // reusable temporary arrays to avoid GC pressure in hot paths
  private _tmpPtsX = new Float32Array(256);
  private _tmpPtsY = new Float32Array(256);
  // dedicated buffers for the fluid core deformation (128 pts, not shared)
  private _coreXs  = new Float32Array(128);
  private _coreYs  = new Float32Array(128);
  // aurora scratch — pre-allocated Float32Array pairs (max 256 pts per band)
  private _aTopX  = new Float32Array(256);
  private _aTopY  = new Float32Array(256);
  private _aBotX  = new Float32Array(256);
  private _aBotY  = new Float32Array(256);

  // palette
  private pal!: Palette;
  private ramp = [hexNum('#22d3ee'), hexNum('#d946ef')];

  // layers
  private bgLayer   = new PIXI.Container();
  private glowLayer = new PIXI.Container();
  private fgLayer   = new PIXI.Container();

  // bg child nodes
  private sky!:      PIXI.Sprite;
  private moonWrap!: PIXI.Container;
  private _moon!:    { x: number; y: number; r: number };
  private _moonHalo!: PIXI.Sprite;
  private _moonDisc!: PIXI.Sprite;
  private clouds!:   PIXI.Container;
  private fog!:      PIXI.Container;
  private auroraG!:  PIXI.Graphics;
  private stars!:    PIXI.Container;
  private shootG!:   PIXI.Graphics;
  private mountains!: PIXI.Container;
  private cityG!:    PIXI.Container;
  private reflect!:  PIXI.Container;
  private rainMidC!: PIXI.Container;

  private _clouds:  CloudItem[]   = [];
  private _fogBlobs: FogBlob[]    = [];
  private _stars:   StarItem[]    = [];
  private _shoots:  ShootItem[]   = [];
  private _ridges:  RidgeState[]  = [];
  private _city:    CityItem[]    = [];
  private _reflStreaks: ReflStreak[] = [];
  private _rainMid: RainDrop[]    = [];
  private _rainFg:  RainDrop[]    = [];
  private _auroraBands: AuroraBand[] = [];

  // glow centre
  private center!:    PIXI.Container;
  private aura1!:     PIXI.Sprite;
  private aura2!:     PIXI.Sprite;
  private moonGlow!:  PIXI.Sprite;
  private shock!:     PIXI.Graphics;
  private comets!:    PIXI.Graphics;
  private fluid!:     PIXI.Graphics;
  private eq!:        PIXI.Graphics;
  private wave!:      PIXI.Graphics;
  private bassRing!:  PIXI.Graphics;
  private particles!: PIXI.Container;
  private sparkles!:  PIXI.Container;
  private coreGlow!:  PIXI.Sprite;
  private coreBlob!:  PIXI.Graphics;
  private coreStains!: PIXI.Container;
  private coreWrap!:  PIXI.Container;

  private _lavaBlobs: LavaBlob[] = [];
  // circular mask clips lava blobs to the core disc
  private _stainsMask!: PIXI.Graphics;
  private _shocks:     Shock[]     = [];
  private _sparkPool:  SparkItem[] = [];
  private _cometPool:  CometItem[] = [];
  private _parts:      Particle[]  = [];

  // shared textures
  private texDot:   PIXI.Texture;
  private texSpark: PIXI.Texture;
  private texGlow:  PIXI.Texture;
  private texRain:  PIXI.Texture;

  // layout (recalculated on resize)
  private cx = 0; private cy = 0;
  private coreR = 60; private eqInner = 150; private barMax = 162;
  private _a1 = 486; private _a2 = 972; private _cg = 252;

  // bloom filter
  private bloom: AdvancedBloomFilter | null = null;

  // ── Construction ─────────────────────────────────────────────────────────────

  constructor(app: PIXI.Application, audio: AudioEngine, options: LofiRainVisualizerOptions = {}) {
    this.app   = app;
    this.audio = audio;
    this.showBackground = options.showBackground ?? true;

    this.texDot   = radialTexture(128);
    this.texSpark = sparkTexture(96);
    this.texGlow  = radialTexture(512, 0);
    this.texRain  = mkRainTex();

    app.stage.addChild(this.bgLayer, this.glowLayer, this.fgLayer);

    try {
      this.bloom = new AdvancedBloomFilter({
        threshold: 0.32, bloomScale: 0.9, brightness: 1.0, blur: 9, quality: 6,
      });
      this.glowLayer.filters = [this.bloom];
    } catch { /* noop */ }

    this._parsePalette(['#67e8f9', '#818cf8', '#0a1424', '#04070f', '#f0a868']);
    this._buildCenter();
    this._buildParticles();
    this.resize();
  }

  // ── Palette ───────────────────────────────────────────────────────────────────

  private _parsePalette(arr: string[]) {
    this.pal = {
      primary:   hexNum(arr[0]),
      secondary: hexNum(arr[1]),
      bgTop:     hexNum(arr[2]),
      bgBot:     hexNum(arr[3]),
      accent:    hexNum(arr[4]),
    };
  }

  // ── Smooth spectrum (7-tap weighted average, run once per frame) ──────────────

  private _preSmooth() {
    const src = this.audio.spectrum;
    const dst = this._smoothSpec;
    const N   = src.length;
    // weights: [0.04, 0.1, 0.2, 0.32, 0.2, 0.1, 0.04]  (sum = 1.0)
    for (let i = 0; i < N; i++) {
      dst[i] =
        src[Math.max(0, i - 3)] * 0.04 +
        src[Math.max(0, i - 2)] * 0.10 +
        src[Math.max(0, i - 1)] * 0.20 +
        src[i]                  * 0.32 +
        src[Math.min(N - 1, i + 1)] * 0.20 +
        src[Math.min(N - 1, i + 2)] * 0.10 +
        src[Math.min(N - 1, i + 3)] * 0.04;
    }
  }

  // ── Colour ramp ───────────────────────────────────────────────────────────────

  private rampColor(t: number): number {
    const R = this.ramp, n = R.length;
    let f = (t + this._cycle) % 1; if (f < 0) f += 1;
    const x = f * n;
    const i = Math.floor(x) % n;
    return mixNum(R[i], R[(i + 1) % n], x - Math.floor(x));
  }

  // ── Centre build ─────────────────────────────────────────────────────────────

  private _buildCenter() {
    const c = this.center = new PIXI.Container();
    this.glowLayer.addChild(c);

    const mkGlow = () => {
      const s = new PIXI.Sprite(this.texGlow);
      s.anchor.set(0.5);
      (s as any).blendMode = 'add';
      return s;
    };

    this.aura2     = mkGlow();
    this.aura1     = mkGlow();
    this.moonGlow  = mkGlow();
    this.coreGlow  = mkGlow();
    this.shock     = new PIXI.Graphics();
    this.comets    = new PIXI.Graphics();
    this.fluid     = new PIXI.Graphics();
    this.eq        = new PIXI.Graphics();
    this.wave      = new PIXI.Graphics();
    this.bassRing  = new PIXI.Graphics();
    this.particles = new PIXI.Container();
    this.sparkles  = new PIXI.Container();
    this.coreBlob  = new PIXI.Graphics();
    this.coreStains = new PIXI.Container();
    this.coreWrap  = new PIXI.Container();
    this.coreWrap.addChild(this.coreGlow, this.coreBlob, this.coreStains);

    this.aura1.tint    = this.pal.primary;
    this.aura2.tint    = this.pal.secondary;
    this.coreGlow.tint = 0xffffff;

    // circular mask clips lava blobs to the core disc
    this._stainsMask = new PIXI.Graphics();
    this.coreStains.mask = this._stainsMask;
    this.coreWrap.addChild(this._stainsMask);

    // lava-lamp blobs — each rises/sinks on its own sinusoidal heat cycle
    const blobTints = [this.pal.primary, this.pal.secondary, this.pal.accent,
                       mixNum(this.pal.primary, 0xffffff, 0.4),
                       mixNum(this.pal.secondary, this.pal.accent, 0.5),
                       this.pal.primary, this.pal.secondary];
    for (let i = 0; i < 7; i++) {
      const s = new PIXI.Sprite(this.texGlow);
      s.anchor.set(0.5); (s as any).blendMode = 'add';
      s.tint = blobTints[i % blobTints.length];
      this.coreStains.addChild(s);
      this._lavaBlobs.push({
        spr:   s,
        phase: (i / 7) * TAU,          // evenly staggered so they don't all align
        speed: 0.40 + Math.random() * 0.35,
        xCtr:  (Math.random() - 0.5) * 0.45,
        xAmp:  0.12 + Math.random() * 0.20,
        xFreq: 0.25 + Math.random() * 0.45,
        xPh:   Math.random() * TAU,
        sz:    0.50 + Math.random() * 0.55,
        react: 0.6  + Math.random() * 0.9,
      });
    }

    c.addChild(
      this.moonGlow, this.aura2, this.aura1, this.shock, this.particles,
      this.fluid, this.bassRing, this.eq, this.wave, this.coreWrap,
      this.comets, this.sparkles,
    );

    gsap.to(this.coreWrap.scale, { x: 1.05, y: 1.05, duration: 4.2, yoyo: true, repeat: -1, ease: 'sine.inOut' });
  }

  // ── Particles ─────────────────────────────────────────────────────────────────

  private _buildParticles() {
    this.particles.removeChildren();
    this._parts = [];
    const n = 130;
    const tints = [this.pal.primary, this.pal.secondary, this.pal.accent];
    for (let i = 0; i < n; i++) {
      const darter = Math.random() < 0.42;
      const r = Math.random();
      const sz = darter ? 1.2 + r * 3 : 2 + r * 4.5;
      const s = new PIXI.Sprite(this.texDot);
      s.anchor.set(0.5); (s as any).blendMode = 'add';
      s.tint = tints[i % 3];
      s.scale.set(sz / 64);
      this.particles.addChild(s);
      this._parts.push({
        spr: s, ang0: Math.random() * TAU, rad: 0.8 + Math.random() * 1.6,
        x: null, y: null, vx: 0, vy: 0,
        wAng: Math.random() * TAU,
        wTurn:  darter ? 0.5  : 0.25,
        wander: darter ? 340 + Math.random() * 260 : 120 + Math.random() * 120,
        swirl:  (Math.random() < 0.5 ? 1 : -1) * (darter ? 120 + Math.random() * 160 : 40 + Math.random() * 70),
        drag:   darter ? 0.95 : 0.93,
        react:  darter ? 1.8  + Math.random() * 1.8 : 0.5 + Math.random() * 0.8,
        base: 0.18 + Math.random() * 0.4, size: sz,
      });
    }
  }

  // ── Background build ──────────────────────────────────────────────────────────

  private _buildBackground() {
    this.bgLayer.removeChildren();
    const W = this.app.screen.width, H = this.app.screen.height;
    const p = this.pal;

    // sky gradient
    this.sky = new PIXI.Sprite(gradientTexture(p.bgTop, p.bgBot));
    this.sky.width = W; this.sky.height = H;
    this.bgLayer.addChild(this.sky);

    // moon
    this.moonWrap = new PIXI.Container();
    this.bgLayer.addChild(this.moonWrap);
    const mr = Math.max(40, Math.min(W, H) * 0.07);
    this._moon = { x: W * (0.74 + Math.random() * 0.14), y: H * (0.2 + Math.random() * 0.12), r: mr };
    const halo = new PIXI.Sprite(this.texGlow);
    halo.anchor.set(0.5); (halo as any).blendMode = 'add'; halo.tint = 0xeaf2ff;
    halo.width = halo.height = mr * 14; halo.alpha = 0.16;
    const disc = new PIXI.Sprite(this.texGlow);
    disc.anchor.set(0.5); (disc as any).blendMode = 'add'; disc.tint = 0xffffff;
    disc.width = disc.height = mr * 4.2; disc.alpha = 0.5;
    const core = new PIXI.Graphics();
    core.circle(0, 0, mr); core.fill({ color: 0xf3f7ff, alpha: 0.95 });
    core.circle(0, 0, mr); core.fill({ color: p.primary, alpha: 0.06 });
    this.moonWrap.position.set(this._moon.x, this._moon.y);
    this.moonWrap.addChild(halo, disc, core);
    this._moonHalo = halo; this._moonDisc = disc;

    // moonlit clouds
    this.clouds = new PIXI.Container();
    this.bgLayer.addChild(this.clouds);
    this._clouds = [];
    for (let i = 0; i < 4; i++) {
      const s = new PIXI.Sprite(this.texGlow);
      s.anchor.set(0.5); (s as any).blendMode = 'add'; s.tint = 0xc9d8ff;
      const w = (0.5 + Math.random() * 0.7) * W;
      s.width = w; s.height = w * (0.16 + Math.random() * 0.1);
      s.x = Math.random() * W; s.y = H * (0.12 + Math.random() * 0.34);
      s.alpha = 0.05 + Math.random() * 0.05;
      this.clouds.addChild(s);
      this._clouds.push({ spr: s, speed: (0.003 + Math.random() * 0.006) * W, baseA: s.alpha });
    }

    // nebula fog
    this.fog = new PIXI.Container();
    this.bgLayer.addChild(this.fog);
    this._fogBlobs = [];
    const fogTints = [p.primary, p.secondary, p.accent, p.secondary];
    for (let i = 0; i < 3; i++) {
      const s = new PIXI.Sprite(this.texGlow);
      s.anchor.set(0.5); (s as any).blendMode = 'add'; s.tint = fogTints[i % fogTints.length];
      const r = (0.4 + Math.random() * 0.5) * Math.max(W, H);
      s.width = s.height = r * 2;
      const y = H * (0.18 + Math.random() * 0.5);
      s.y = y; s.x = Math.random() * W;
      s.alpha = 0.10 + Math.random() * 0.08;
      this.fog.addChild(s);
      this._fogBlobs.push({
        spr: s,
        speed: (0.004 + Math.random() * 0.01) * (Math.random() < 0.5 ? 1 : -1) * W,
        baseA: s.alpha, baseY: y,
        bob: 8 + Math.random() * 26, phase: Math.random() * TAU,
      });
    }

    // aurora
    this.auroraG = new PIXI.Graphics();
    (this.auroraG as any).blendMode = 'add';
    this.bgLayer.addChild(this.auroraG);
    this._auroraBands = [
      { col: p.primary,   baseY: H * 0.26, amp: H * 0.05,  thick: H * 0.12, fx: 1.1, sp:  0.10, a: 0.03  },
      { col: p.secondary, baseY: H * 0.17, amp: H * 0.06,  thick: H * 0.09, fx: 0.7, sp: -0.08, a: 0.026 },
      { col: p.accent,    baseY: H * 0.36, amp: H * 0.045, thick: H * 0.14, fx: 1.5, sp:  0.13, a: 0.02  },
    ];

    // stars
    this.stars = new PIXI.Container();
    this.bgLayer.addChild(this.stars);
    this._stars = [];
    for (let i = 0; i < 200; i++) {
      const s = new PIXI.Sprite(this.texDot);
      s.anchor.set(0.5); (s as any).blendMode = 'add';
      s.tint = Math.random() < 0.2 ? p.primary : 0xffffff;
      const sz = 0.6 + Math.random() * 2.2;
      s.scale.set(sz / 64);
      s.x = Math.random() * W; s.y = Math.random() * H * 0.82;
      this.stars.addChild(s);
      this._stars.push({ spr: s, base: 0.25 + Math.random() * 0.6, tw: 0.5 + Math.random() * 2.5, ph: Math.random() * TAU, drift: 2 + Math.random() * 8 });
    }

    // shooting stars
    this.shootG = new PIXI.Graphics();
    (this.shootG as any).blendMode = 'add';
    this.bgLayer.addChild(this.shootG);
    this._shoots = [];
    if (!this._shootTimer) this._shootTimer = 1.5 + Math.random() * 3;

    // mountains — 4 parallax layers with smooth quadratic ridges
    this.mountains = new PIXI.Container();
    this.bgLayer.addChild(this.mountains);
    this._ridges = [];
    const mLayers = [
      { mix: 0.70, ampF: 0.11, baseF: 0.60, speed: 2,  seed: 5  },
      { mix: 0.55, ampF: 0.16, baseF: 0.70, speed: 4,  seed: 11 },
      { mix: 0.34, ampF: 0.22, baseF: 0.80, speed: 9,  seed: 47 },
      { mix: 0.14, ampF: 0.30, baseF: 0.93, speed: 16, seed: 83 },
    ];
    for (const L of mLayers) {
      let col = mixNum(p.bgBot, p.bgTop, L.mix);
      col = mixNum(col, p.primary, 0.08);
      const g = this._makeRidge(W, H, L, col);
      this.mountains.addChild(g);
      this._ridges.push({ g, speed: L.speed, dim: 0xb9bdc9 });
    }

    // city lights
    this.cityG = new PIXI.Container();
    this.bgLayer.addChild(this.cityG);
    this._city = [];
    const warm = [0xf0a868, 0xf6c78a, 0xffd9a0, 0xfff0d0, p.primary];
    const nCity = Math.round(W / 26);
    for (let i = 0; i < nCity; i++) {
      const s = new PIXI.Sprite(this.texDot);
      s.anchor.set(0.5); (s as any).blendMode = 'add';
      s.tint = warm[(Math.random() * warm.length) | 0];
      const sz = 2.5 + Math.random() * 5;
      s.scale.set(sz / 64);
      s.x = Math.random() * W; s.y = H * (0.88 + Math.random() * 0.06);
      this.cityG.addChild(s);
      this._city.push({ spr: s, base: 0.55 + Math.random() * 0.6, tw: 0.6 + Math.random() * 2.2, ph: Math.random() * TAU });
    }

    // wet reflection streaks
    this.reflect = new PIXI.Container();
    this.bgLayer.addChild(this.reflect);
    this._reflStreaks = [];
    const reflCols = [p.primary, p.secondary, 0xffffff, p.accent, p.primary, p.secondary];
    for (let i = 0; i < reflCols.length; i++) {
      const s = new PIXI.Sprite(this.texGlow);
      s.anchor.set(0.5); (s as any).blendMode = 'add'; s.tint = reflCols[i];
      this.reflect.addChild(s);
      this._reflStreaks.push({ spr: s, row: i, wob: 0.4 + Math.random() * 0.8, ph: Math.random() * TAU });
    }

    // mid-ground rain
    this.rainMidC = new PIXI.Container();
    this.bgLayer.addChild(this.rainMidC);
    this._rainMid = this._spawnRain(this.rainMidC, Math.round(170 * this.rainMul), {
      len: [40, 90], w: [0.6, 1.3], spd: [620, 900], alpha: [0.12, 0.3], tint: p.primary,
    });

    // fg rain
    this.fgLayer.removeChildren();
    const rainFgC = new PIXI.Container();
    this.fgLayer.addChild(rainFgC);
    this._rainFg = this._spawnRain(rainFgC, Math.round(44 * this.rainMul), {
      len: [90, 180], w: [1.4, 3], spd: [1100, 1600], alpha: [0.16, 0.4], tint: 0xdff1ff,
    });
  }

  // Mountain ridge — smooth quadratic silhouette instead of raw lineTo segments
  private _makeRidge(
    W: number, H: number,
    L: { ampF: number; baseF: number; seed: number },
    color: number,
  ): PIXI.Graphics {
    const g = new PIXI.Graphics();
    const rng = mulberry(L.seed);
    const phases = [rng() * TAU, rng() * TAU, rng() * TAU, rng() * TAU, rng() * TAU];
    const amp = H * L.ampF, baseY = H * L.baseF;
    const ridgeH = (x: number) => {
      const u = (x % W) / W * TAU;
      let v = 0.55 * Math.sin(u + phases[0]) + 0.22 * Math.sin(2 * u + phases[1])
            + 0.14 * Math.sin(3 * u + phases[2]) + 0.06 * Math.sin(5 * u + phases[3])
            + 0.04 * Math.sin(7 * u + phases[4]);
      v = (v + 1) / 2;
      return Math.pow(v, 1.15) * amp;
    };
    // Build ridge points with finer step for smoother curves
    const step = Math.max(4, W / 240);
    const pts: [number, number][] = [];
    for (let x = 0; x <= 2 * W; x += step) {
      pts.push([x, baseY - ridgeH(x)]);
    }
    // Polygon: bottom-left → smooth ridge → bottom-right → close
    g.moveTo(0, H);
    g.lineTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      g.quadraticCurveTo(
        pts[i][0], pts[i][1],
        (pts[i][0] + pts[i + 1][0]) * 0.5, (pts[i][1] + pts[i + 1][1]) * 0.5,
      );
    }
    g.lineTo(2 * W, H);
    g.closePath();
    g.fill({ color, alpha: 1 });
    return g;
  }

  private _spawnRain(
    container: PIXI.Container, n: number,
    o: { len: [number, number]; w: [number, number]; spd: [number, number]; alpha: [number, number]; tint: number },
  ): RainDrop[] {
    const W = this.app.screen.width, H = this.app.screen.height;
    const arr: RainDrop[] = [];
    const ang = 0.18;
    for (let i = 0; i < n; i++) {
      const s = new PIXI.Sprite(this.texRain);
      s.anchor.set(0.5); (s as any).blendMode = 'add'; s.tint = o.tint;
      const len = lerp(o.len[0], o.len[1], Math.random());
      s.width = lerp(o.w[0], o.w[1], Math.random()); s.height = len;
      s.rotation = -ang;
      s.alpha = lerp(o.alpha[0], o.alpha[1], Math.random());
      s.x = Math.random() * (W + 200) - 100; s.y = Math.random() * H;
      container.addChild(s);
      arr.push({ spr: s, vy: lerp(o.spd[0], o.spd[1], Math.random()), len, baseA: s.alpha });
    }
    return arr;
  }

  // ── Resize ────────────────────────────────────────────────────────────────────

  resize() {
    const W = this.app.screen.width, H = this.app.screen.height;
    this.cx = W / 2; this.cy = H * 0.46;
    this.center.position.set(this.cx, this.cy);
    const m = Math.min(W, H);
    this.coreR    = Math.max(30, m * 0.064);
    this.eqInner  = this.coreR * 2.5;
    this.barMax   = this.coreR * 2.7;
    this._a1 = this.barMax * 3.0;
    this._a2 = this.barMax * 6.0;
    this._cg = this.coreR  * 4.2;
    this.aura1.width  = this.aura1.height  = this._a1;
    this.aura2.width  = this.aura2.height  = this._a2;
    this.coreGlow.width  = this.coreGlow.height  = this._cg;
    this.moonGlow.width  = this.moonGlow.height   = this._cg * 3.4;
    if (this.bloom) this.glowLayer.filterArea = new PIXI.Rectangle(0, 0, W, H);
    if (this.showBackground) this._buildBackground();
  }

  // ── Per-frame update ──────────────────────────────────────────────────────────

  update(dt: number) {
    // Smooth raw spectrum bins once per frame — all drawers use _smoothSpec
    this._preSmooth();

    this.t += dt;
    const a = this.audio;
    const b = a.bands;
    const bass = clamp(b.bass * this.bassGain, 0, 1.4);
    const vol  = b.volume;

    this._volS  = lerp(this._volS,  vol,  0.05);
    this._bassS = lerp(this._bassS, bass, 0.06);
    const volS = this._volS, bassS = this._bassS;

    this._cycle  += dt * (0.012 + volS * 0.03);
    this._energy  = lerp(this._energy,  clamp((volS - 0.18) * 2.2, 0, 1), 0.04);
    this._attack  = lerp(this._attack,  clamp((volS - 0.25) * 5, 0, 2.2),  0.18);

    // bloom
    if (this.bloom && (this.bloom as any).bloomScale != null) {
      const target = (0.45 + volS * 0.8) * this.bloomMul;
      (this.bloom as any).bloomScale = lerp((this.bloom as any).bloomScale as number, target, 0.04);
    }

    // moonlight glow
    this.moonGlow.tint  = mixNum(this.pal.primary, 0xffffff, 0.5);
    this.moonGlow.alpha = 0.12 + volS * 0.14 + 0.03 * Math.sin(this.t * 0.5);
    this.moonGlow.scale.set((this._cg * 3.4 / 512) * (1 + volS * 0.06));

    // auras
    this.aura1.scale.set((this._a1 / 512) * (0.9 + bassS * 0.35));
    this.aura1.alpha = 0.10 + volS * 0.22;
    this.aura2.scale.set((this._a2 / 512) * (0.95 + volS * 0.25));
    this.aura2.alpha = 0.05 + volS * 0.13;
    this.coreGlow.alpha = 0.28 + volS * 0.3 + this._beatPop * 0.18;

    // beat pulse
    if (a.beat) this._beatPop = Math.max(this._beatPop, (a.beatStrength || 0.6) * 0.5);
    this._beatPop = lerp(this._beatPop, 0, 0.06);
    if (a.beat) this._bgFlash = Math.max(this._bgFlash, (a.beatStrength || 0.6) * 0.4);
    this._bgFlash = lerp(this._bgFlash, 0, 0.05);
    this.coreGlow.scale.set((this._cg / 512) * (1 + this._beatPop * 0.04));

    this._drawCoreFluid(bassS, b.mids, volS);
    this._updateLavaBlobs(bassS, volS);

    if (a.beat && (a.beatStrength || 0) > 0.45) {
      this._shocks.push({ r: this.coreR * 1.6, a: 0.16 * (a.beatStrength || 0.5), w: Math.max(2, this.coreR * 0.18) });
    }
    this._drawShocks(dt);
    this._drawFluid(volS);
    this._drawEq(bassS, b.mids);
    this._drawWave(b.mids);
    this._drawBassRing(bassS);
    this._updateComets(dt, a, bassS);
    this._updateParticles(dt, volS, bassS);
    this._updateSparkles(dt, b.highs);
    if (this.showBackground) this._updateBackground(dt, volS, bassS);
  }

  // ── Glow layer drawers ────────────────────────────────────────────────────────

  // Core is a wavy fluid disc — sinusoidal deformations driven by bass/mids/beat,
  // drawn as a smooth 128-pt quadratic loop. Stains mask tracks the live contour.
  private _drawCoreFluid(bass: number, mids: number, vol: number) {
    const N  = 128;
    const R  = this.coreR;
    const br = R * (1 + bass * 0.18 + this._beatPop * 0.10);  // base radius pulse
    const xs = this._coreXs, ys = this._coreYs;

    for (let i = 0; i < N; i++) {
      const ang = (i / N) * TAU;
      // Layered harmonic ripples — each harmonic responds to a different band
      const d1 = bass  * 0.16 * Math.sin(3  * ang + this.t * 1.80);
      const d2 = bass  * 0.08 * Math.sin(5  * ang - this.t * 2.30);
      const d3 = mids  * 0.11 * Math.sin(7  * ang + this.t * 3.10);
      const d4 = mids  * 0.05 * Math.sin(11 * ang - this.t * 1.70);
      const d5 = this._beatPop * 0.20 * Math.sin(2 * ang + this.t * 4.50);
      const d6 = vol   * 0.04 * Math.sin(9  * ang + this.t * 0.85);
      const r  = br * (1 + d1 + d2 + d3 + d4 + d5 + d6);
      xs[i] = Math.cos(ang) * r;
      ys[i] = Math.sin(ang) * r;
    }

    const g = this.coreBlob;
    g.clear();

    // Outer tinted fill
    smoothLoop(g, xs, ys, N);
    g.fill({ color: this.pal.primary, alpha: 0.36 + bass * 0.20 });

    // Glowing border
    smoothLoop(g, xs, ys, N);
    g.stroke({ width: Math.max(1.5, R * 0.048), color: 0xffffff, alpha: 0.65, cap: 'round', join: 'round' });

    // Bright inner highlight (60 % scale — same waviness, smaller)
    smoothLoop(g, xs, ys, N, 0.58);
    g.fill({ color: 0xffffff, alpha: 0.72 });

    // Stains mask follows the exact fluid contour
    this._stainsMask.clear();
    smoothLoop(this._stainsMask, xs, ys, N);
    this._stainsMask.fill({ color: 0xffffff, alpha: 1 });
  }

  // Lava-lamp: blobs rise/sink on a sinusoidal heat cycle, with bass = heat.
  private _updateLavaBlobs(bass: number, vol: number) {
    const R = this.coreR;
    for (const b of this._lavaBlobs) {
      // Advance phase — bass adds heat, speeding the cycle
      b.phase += (b.speed + bass * b.react * 0.06) * (1 / 60);
      if (b.phase > TAU) b.phase -= TAU;

      // Vertical: sin reaches top at PI/2, bottom at 3*PI/2
      const riseT = (1 - Math.cos(b.phase)) * 0.5;   // 0 = bottom, 1 = top
      const y = (-riseT * 2 + 1) * R * 0.72;         // +R*0.72 bottom, -R*0.72 top

      // Horizontal drift
      const x = (b.xCtr + Math.sin(this.t * b.xFreq + b.xPh) * b.xAmp) * R;

      // Size: larger and brighter near the top (blob expands when hot)
      const heat = riseT + bass * b.react * 0.3;
      const sz = R * b.sz * (0.55 + heat * 0.70);

      b.spr.x = x;
      b.spr.y = y;
      b.spr.width = b.spr.height = sz * 2;
      b.spr.alpha = clamp(0.12 + heat * 0.40 + vol * 0.18, 0, 0.85);
    }
  }

  private _drawShocks(dt: number) {
    const g = this.shock; g.clear();
    const grow = Math.max(this.app.screen.width, this.app.screen.height) * 0.55;
    for (let i = this._shocks.length - 1; i >= 0; i--) {
      const s = this._shocks[i];
      s.r += grow * dt; s.a -= dt * 0.7; s.w *= (1 - dt * 0.6);
      if (s.a <= 0) { this._shocks.splice(i, 1); continue; }
      g.circle(0, 0, s.r);
      g.stroke({ width: Math.max(0.5, s.w), color: this.pal.secondary, alpha: s.a, cap: 'round', join: 'round' });
    }
  }

  // Circular EQ bars — 90 Gaussian-smoothed bars per half-circle.
  // Each bar: single moveTo/lineTo with cap:'round' so tips are pill-shaped.
  // Data is pre-smoothed via _smoothSpec → no raw-bin jagginess.
  private _drawEq(bass: number, _mids: number) {
    const g = this.eq; g.clear();
    const spec   = this._smoothSpec;
    const half   = 90;
    const inner  = this.eqInner + bass * this.coreR * 0.35;
    const barW   = Math.max(1.5, (TAU * inner / (half * 2)) * 0.62);
    const usable = 250;
    const anchor = -Math.PI / 2;
    const energy = this._energy;
    const muted  = mixNum(this.pal.primary, this.pal.secondary, 0.5);

    for (let k = 0; k <= half; k++) {
      const t   = k / half;
      const bin = Math.floor(Math.pow(t, 1.5) * usable) + 2;
      const vv  = spec[Math.min(bin, spec.length - 1)] || 0;
      const len = 3 + vv * this.barMax * 0.6 * this.intensity;
      const color = mixNum(muted, this.rampColor(t), energy * 0.5);

      for (const side of [-1, 1]) {
        if (side === 1 && (k === 0 || k === half)) continue;
        const ang = anchor + side * t * Math.PI;
        const cc = Math.cos(ang), ss = Math.sin(ang);
        g.moveTo(cc * inner, ss * inner);
        g.lineTo(cc * (inner + len), ss * (inner + len));
        g.stroke({ width: barW, color, alpha: 0.35 + vv * 0.4, cap: 'round', join: 'round' });
      }
    }
  }

  // Fluid spectrum ring — 256-point smooth quadratic loop
  private _drawFluid(vol: number) {
    const g = this.fluid; g.clear();
    const spec   = this._smoothSpec;
    const M      = 256;
    const base   = this.eqInner * 0.99;
    const amp    = this.barMax  * 0.6 * this.intensity;
    const usable = 250;
    const xs = this._tmpPtsX, ys = this._tmpPtsY;
    for (let i = 0; i < M; i++) {
      const d  = i / M;
      const tt = d <= 0.5 ? d * 2 : (1 - d) * 2;
      const bin = Math.floor(Math.pow(tt, 1.5) * usable) + 2;
      const vv  = spec[Math.min(bin, spec.length - 1)] || 0;
      const wob = Math.sin(i * 0.6 + this.t * 1.3) * this.coreR * 0.05
                + Math.sin(i * 0.21 - this.t * 0.8) * this.coreR * 0.04;
      const rr  = base + vv * amp + wob;
      const ang = -Math.PI / 2 + d * TAU;
      xs[i] = Math.cos(ang) * rr;
      ys[i] = Math.sin(ang) * rr;
    }
    smoothLoop(g, xs, ys, M);
    g.fill({ color: this.pal.primary, alpha: 0.07 + vol * 0.10 });
    smoothLoop(g, xs, ys, M);
    g.stroke({ width: 2, color: this.pal.primary, alpha: 0.32 + vol * 0.35, cap: 'round', join: 'round' });
  }

  // Waveform ring — 256-point smooth quadratic loop
  private _drawWave(mids: number) {
    const g = this.wave; g.clear();
    const spec   = this._smoothSpec;
    const baseR  = this.eqInner * 0.97;
    const steps  = 256;
    const xs = this._tmpPtsX, ys = this._tmpPtsY;
    for (let i = 0; i < steps; i++) {
      const f  = i / steps;
      const tt = f <= 0.5 ? f * 2 : (1 - f) * 2;
      const bin = 14 + Math.floor(Math.pow(tt, 1.3) * 150);
      const wob = (spec[Math.min(bin, spec.length - 1)] || 0) * this.coreR * 0.6 * this.intensity;
      const ang = f * TAU - Math.PI / 2;
      const rr  = baseR + Math.sin(ang * 4 + this.t * 0.9) * 2 + wob;
      xs[i] = Math.cos(ang) * rr;
      ys[i] = Math.sin(ang) * rr;
    }
    const thick = 2 + mids * 3.5 * this.intensity;
    // Soft coloured halo
    smoothLoop(g, xs, ys, steps);
    g.stroke({ width: thick + 7, color: this.pal.primary, alpha: 0.12 + mids * 0.16, cap: 'round', join: 'round' });
    // Crisp white line
    smoothLoop(g, xs, ys, steps);
    g.stroke({ width: thick, color: 0xffffff, alpha: 0.85, cap: 'round', join: 'round' });
  }

  private _drawBassRing(bass: number) {
    const g = this.bassRing; g.clear();
    const rr = this.coreR * 1.5 + bass * this.coreR * 0.8;
    g.circle(0, 0, rr);
    g.stroke({ width: 1.5 + bass * 3, color: this.pal.secondary, alpha: 0.18 + bass * 0.3, cap: 'round', join: 'round' });
  }

  private _updateComets(dt: number, a: AudioEngine, bass: number) {
    if (a.beat && (a.beatStrength || 0) > 0.55) {
      const n = 1 + Math.floor((a.beatStrength - 0.5) * 4);
      for (let i = 0; i < n; i++) {
        this._cometPool.push({
          ang: Math.random() * TAU, r: this.eqInner + this.barMax * 0.5,
          v: 360 + Math.random() * 520 + bass * 300,
          life: 0.55 + Math.random() * 0.5, max: 1,
          len: 50 + Math.random() * 90,
          col: this.rampColor(Math.random()),
        });
      }
    }
    const g = this.comets; g.clear();
    const lim = Math.max(this.app.screen.width, this.app.screen.height);
    for (let i = this._cometPool.length - 1; i >= 0; i--) {
      const c = this._cometPool[i];
      c.life -= dt; c.r += c.v * dt;
      if (c.life <= 0 || c.r > lim) { this._cometPool.splice(i, 1); continue; }
      const k  = Math.min(1, c.life / c.max);
      const dx = Math.cos(c.ang), dy = Math.sin(c.ang);
      const hx = dx * c.r,           hy = dy * c.r;
      const tx = dx * (c.r - c.len), ty = dy * (c.r - c.len);
      // Single stroke tail→head — avoids the midpoint seam of two separate segments
      g.moveTo(tx, ty);
      g.lineTo(hx, hy);
      g.stroke({ width: 2.2, color: c.col, alpha: k, cap: 'round', join: 'round' });
      // Bright head dot
      g.circle(hx, hy, 2.4);
      g.fill({ color: 0xffffff, alpha: k });
    }
  }

  private _updateParticles(dt: number, vol: number, bass: number) {
    const maxR = this.barMax * 3.2, minR = this.eqInner * 0.6;
    for (const p of this._parts) {
      if (p.x === null) {
        const hr = this.barMax * p.rad;
        p.x = Math.cos(p.ang0) * hr; p.y = Math.sin(p.ang0) * hr;
      }
      let d = Math.hypot(p.x!, p.y!) || 0.0001;
      const ux = p.x! / d, uy = p.y! / d, tx = -uy, ty = ux;
      p.wAng += (Math.random() - 0.5) * p.wTurn * 0.4;
      let ax = Math.cos(p.wAng) * p.wander * 0.16;
      let ay = Math.sin(p.wAng) * p.wander * 0.16 + 6;
      const err = this.barMax * p.rad - d;
      ax += ux * err * 1.1 + tx * p.swirl * 0.18 + ux * bass * this.coreR * 1.4;
      ay += uy * err * 1.1 + ty * p.swirl * 0.18 + uy * bass * this.coreR * 1.4;
      p.vx = (p.vx + ax * dt) * p.drag;
      p.vy = (p.vy + ay * dt) * p.drag;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 120) { p.vx *= 120 / sp; p.vy *= 120 / sp; }
      p.x! += p.vx * dt; p.y! += p.vy * dt;
      d = Math.hypot(p.x!, p.y!);
      if (d > maxR) { p.x! *= maxR / d; p.y! *= maxR / d; }
      else if (d < minR) { p.x! *= minR / d; p.y! *= minR / d; }
      p.spr.x = p.x!; p.spr.y = p.y!;
      p.spr.alpha = p.base * (0.3 + vol * 0.5 + bass * 0.3) * 0.7;
      p.spr.scale.set((p.size / 64) * (1 + bass * 0.3));
    }
  }

  private _updateSparkles(dt: number, highs: number) {
    if (highs > 0.16 && Math.random() < highs * 1.4) {
      const count = 1 + Math.floor(highs * 3);
      for (let k = 0; k < count; k++) this._spawnSpark();
    }
    for (let i = this._sparkPool.length - 1; i >= 0; i--) {
      const s = this._sparkPool[i];
      s.life -= dt;
      if (s.life <= 0) { s.spr.visible = false; this._sparkPool.splice(i, 1); continue; }
      s.rad += s.vr * dt;
      s.spr.x = Math.cos(s.ang) * s.rad;
      s.spr.y = Math.sin(s.ang) * s.rad;
      const k = s.life / s.max;
      s.spr.alpha = k;
      s.spr.scale.set(s.size * (0.4 + (1 - k) * 0.9) / 96);
      s.spr.rotation += dt * 2;
    }
  }

  private _spawnSpark() {
    const s = new PIXI.Sprite(this.texSpark);
    s.anchor.set(0.5); (s as any).blendMode = 'add';
    s.tint = Math.random() < 0.5 ? 0xffffff : this.pal.primary;
    const ang = Math.random() * TAU;
    const rad = this.eqInner + Math.random() * this.barMax;
    const size = 8 + Math.random() * 18;
    s.x = Math.cos(ang) * rad; s.y = Math.sin(ang) * rad;
    this.sparkles.addChild(s);
    this._sparkPool.push({ spr: s, ang, rad, vr: 10 + Math.random() * 40, life: 0.5 + Math.random() * 0.5, max: 1, size });
    if (this._sparkPool.length > 90) this._sparkPool.shift()!.spr.destroy();
  }

  // ── Background update ─────────────────────────────────────────────────────────

  private _updateBackground(dt: number, vol: number, bass: number) {
    const W = this.app.screen.width, H = this.app.screen.height;
    const flash = this._bgFlash;

    if (this._moonHalo) {
      this._moonHalo.alpha = 0.14 + vol * 0.18 + flash * 0.2;
      this._moonHalo.scale.set((this._moon.r * 14 / 512) * (1 + vol * 0.08 + flash * 0.12));
      this._moonDisc.alpha = 0.45 + vol * 0.25 + flash * 0.2;
    }

    for (const c of this._clouds) {
      c.spr.x += c.speed * dt;
      if (c.spr.x > W + c.spr.width / 2) c.spr.x = -c.spr.width / 2;
      c.spr.alpha = c.baseA * (0.7 + vol * 0.6 + flash * 0.5);
    }

    for (const f of this._fogBlobs) {
      f.spr.x += f.speed * dt;
      const rr = f.spr.width / 2;
      if (f.spr.x < -rr) f.spr.x = W + rr;
      if (f.spr.x > W + rr) f.spr.x = -rr;
      f.spr.y = f.baseY + Math.sin(this.t * 0.2 + f.phase) * f.bob;
      f.spr.alpha = f.baseA * (0.6 + vol * 1.0 + flash * 0.5) * this.fogMul;
    }

    for (const st of this._stars) {
      st.spr.alpha = st.base * (0.4 + 0.55 * (0.5 + 0.5 * Math.sin(this.t * st.tw + st.ph))) + flash * 0.3 * st.base;
      st.spr.x -= st.drift * dt;
      if (st.spr.x < -4) st.spr.x = W + 4;
    }

    this._drawAurora(vol, flash);
    this._updateShoots(dt, W, H);

    for (const rg of this._ridges) {
      rg.g.x = -((this.t * rg.speed * 0.5) % W) + Math.sin(this.t * 0.1 + rg.speed) * 3;
      rg.g.y = Math.sin(this.t * 0.25) * 1.5 + bass * (2 + rg.speed) * 0.2;
      rg.g.tint = mixNum(rg.dim, 0xdfe7f2, Math.min(0.5, vol * 0.35 + flash * 0.25));
    }

    this._updateRainSet(this._rainMid, dt, H, W);
    this._updateRainSet(this._rainFg,  dt, H, W);

    if (this.cityG) this.cityG.visible = this.cityOn;
    for (const c of this._city) {
      c.spr.alpha = c.base * (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.t * c.tw + c.ph))) + flash * 0.2;
    }

    this._updateReflection(vol, bass);
  }

  // Aurora ribbons — Float32Array scratch buffers, finer step, smoothLineXY both edges
  private _drawAurora(vol: number, flash: number) {
    const g = this.auroraG; g.clear();
    const W    = this.app.screen.width;
    const step = Math.max(5, W / 160);   // ~160 pts at 1920 — fine enough for smooth curves
    const surge = Math.min(2.2, this._attack);
    const tX = this._aTopX, tY = this._aTopY;
    const bX = this._aBotX, bY = this._aBotY;

    for (const b of this._auroraBands) {
      const a = b.a * (0.45 + vol * 1.05 + flash * 0.8 + surge * 1.3);
      if (a <= 0.002) continue;
      const ampM = b.amp * (1 + surge * 1.7 + flash * 0.5);

      let np = 0;
      for (let x = 0; x <= W && np < 255; x += step) {
        const wob = Math.sin(x * 0.004 * b.fx + this.t * b.sp) * ampM
                  + Math.sin(x * 0.011 - this.t * b.sp * 1.6) * ampM * 0.45;
        const ty  = b.baseY - surge * 16 + wob;
        const th  = b.thick * (0.55 + 0.45 * Math.sin(x * 0.005 + this.t * 0.5)) * (1 + surge * 0.5);
        tX[np] = x;  tY[np] = ty;
        bX[np] = x;  bY[np] = ty + th;
        np++;
      }
      if (np < 2) continue;

      // Top edge forward, bottom edge reversed — both smooth quadratic curves
      smoothLineXY(g, tX, tY, np);
      smoothLineXYRev(g, bX, bY, np);
      g.closePath();
      g.fill({ color: b.col, alpha: a });
    }
  }

  private _updateShoots(dt: number, W: number, H: number) {
    this._shootTimer -= dt;
    if (this._shootTimer <= 0) {
      this._shootTimer = 2.2 + Math.random() * 4.5;
      const dir = Math.random() < 0.5 ? -1 : 1;
      const sp  = 520 + Math.random() * 620;
      const ang = (0.22 + Math.random() * 0.16) * Math.PI;
      this._shoots.push({
        x: dir < 0 ? W * (0.5 + Math.random() * 0.5) : W * Math.random() * 0.5,
        y: H * (0.04 + Math.random() * 0.34),
        vx: -dir * Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        life: 0.5 + Math.random() * 0.5, max: 1,
        len: 90 + Math.random() * 120,
        col: Math.random() < 0.5 ? 0xffffff : this.pal.primary,
      });
    }
    const g = this.shootG; g.clear();
    for (let i = this._shoots.length - 1; i >= 0; i--) {
      const s = this._shoots[i];
      s.life -= dt;
      if (s.life <= 0 || s.x < -200 || s.x > W + 200 || s.y > H) { this._shoots.splice(i, 1); continue; }
      s.x += s.vx * dt; s.y += s.vy * dt;
      const k    = Math.min(1, s.life / s.max);
      const mag  = Math.hypot(s.vx, s.vy) || 1;
      const ux   = s.vx / mag, uy = s.vy / mag;
      const tailX = s.x - ux * s.len, tailY = s.y - uy * s.len;
      // Single seamless stroke from tail to head — no midpoint seam
      g.moveTo(tailX, tailY);
      g.lineTo(s.x, s.y);
      g.stroke({ width: 1.8, color: s.col, alpha: k, cap: 'round', join: 'round' });
      // Bright head dot
      g.circle(s.x, s.y, 1.8);
      g.fill({ color: s.col, alpha: k });
    }
  }

  private _updateRainSet(set: RainDrop[], dt: number, H: number, W: number) {
    const lean = Math.tan(0.18);
    for (const r of set) {
      r.spr.y += r.vy * dt;
      r.spr.x += r.vy * dt * lean;
      if (r.spr.y - r.len > H) {
        r.spr.y = -r.len; r.spr.x = Math.random() * (W + 200) - 100;
      } else if (r.spr.x > W + 100) {
        r.spr.x -= (W + 200);
      }
    }
  }

  private _updateReflection(vol: number, bass: number) {
    if (!this.reflOn) { this.reflect.visible = false; return; }
    this.reflect.visible = true;
    const top  = this.cy + this.coreR * 2.0;
    const rowH = this.coreR * 0.5;
    for (const rr of this._reflStreaks) {
      const s = rr.spr;
      const shimmer = 0.6 + 0.4 * Math.sin(this.t * rr.wob + rr.ph);
      s.width  = Math.max(20, (this.coreR * 6) * (1 - rr.row * 0.08) * shimmer);
      s.height = rowH * 0.9;
      s.x = this.cx + Math.sin(this.t * 0.5 + rr.ph) * this.coreR * 0.25;
      s.y = top + rr.row * rowH;
      s.alpha = (0.12 - rr.row * 0.013) * (0.6 + vol * 0.9 + bass * 0.5) * shimmer;
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────

  dispose() {
    gsap.killTweensOf(this.coreWrap.scale);
    this.bgLayer.destroy({ children: true });
    this.glowLayer.destroy({ children: true });
    this.fgLayer.destroy({ children: true });
    this.texDot.destroy();
    this.texSpark.destroy();
    this.texGlow.destroy();
    this.texRain.destroy();
  }
}
