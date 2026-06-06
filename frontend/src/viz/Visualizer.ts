import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import { AdvancedBloomFilter, RGBSplitFilter } from 'pixi-filters';
import { TAU, clamp, lerp, hexNum, mixNum, radialTexture, sparkTexture, gradientTexture } from './util';
import type { VizConfig } from './types';
import type { AudioEngine } from '../audio/AudioEngine';

function mulberry(seed: number): () => number {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Palette {
  primary: number;
  secondary: number;
  bgTop: number;
  bgBot: number;
  accent: number;
}

interface Shock { r: number; a: number; w: number; }
interface Comet { ang: number; r: number; v: number; life: number; max: number; len: number; col: number; }
interface Shoot { x: number; y: number; vx: number; vy: number; life: number; max: number; len: number; col: number; }
interface Stain { spr: PIXI.Sprite; ax: number; ay: number; fx: number; fy: number; phx: number; phy: number; sz: number; react: number; }
interface BlobHarmonic { k: number; amp: number; spd: number; phase: number; }
interface Ridge { g: PIXI.Graphics; speed: number; vy: number; yOff: number; dim: number; }
interface FogBlob { spr: PIXI.Sprite; speed: number; baseA: number; baseY: number; bob: number; phase: number; }
interface CloudSprite { spr: PIXI.Sprite; speed: number; baseA: number; }
interface StarDot { spr: PIXI.Sprite; base: number; tw: number; ph: number; drift: number; }
interface AuroraBand { col: number; baseY: number; amp: number; thick: number; fx: number; sp: number; a: number; }
interface Particle {
  spr: PIXI.Sprite; ang0: number; rad: number;
  x: number | null; y: number | null; vx: number; vy: number;
  wAng: number; wTurn: number; wander: number; swirl: number;
  springK: number; drag: number; react: number; base: number; size: number;
}
interface Spark { spr: PIXI.Sprite; ang: number; rad: number; vr: number; life: number; max: number; size: number; }

export class Visualizer {
  private app: PIXI.Application;
  private audio: AudioEngine;
  private stage: PIXI.Container;
  private t = 0;
  private _cycle = 0;
  private _abr = 0;

  private readonly ramp: number[];
  private readonly texDot: PIXI.Texture;
  private readonly texSpark: PIXI.Texture;
  private readonly texGlow: PIXI.Texture;

  private bgLayer!: PIXI.Container;
  private glowLayer!: PIXI.Container;
  private center!: PIXI.Container;
  private bloom?: AdvancedBloomFilter;
  private rgb?: RGBSplitFilter;
  private coreTween?: gsap.core.Tween;

  // bg
  private sky!: PIXI.Sprite;
  private moonWrap!: PIXI.Container;
  private _moon!: { x: number; y: number; r: number };
  private _moonHalo?: PIXI.Sprite;
  private _moonDisc?: PIXI.Sprite;
  private clouds!: PIXI.Container;
  private _clouds: CloudSprite[] = [];
  private fog!: PIXI.Container;
  private _fogBlobs: FogBlob[] = [];
  private auroraG!: PIXI.Graphics;
  private _auroraBands: AuroraBand[] = [];
  private stars!: PIXI.Container;
  private _stars: StarDot[] = [];
  private shootG!: PIXI.Graphics;
  private _shoots: Shoot[] = [];
  private _shootTimer: number | null = null;
  private mountains!: PIXI.Container;
  private _ridges: Ridge[] = [];

  // center visuals
  private aura1!: PIXI.Sprite;
  private aura2!: PIXI.Sprite;
  private shock!: PIXI.Graphics;
  private comets!: PIXI.Graphics;
  private fluid!: PIXI.Graphics;
  private eq!: PIXI.Graphics;
  private wave!: PIXI.Graphics;
  private bassRing!: PIXI.Graphics;
  private particles!: PIXI.Container;
  private sparkles!: PIXI.Container;
  private coreGlow!: PIXI.Sprite;
  private coreBlob!: PIXI.Graphics;
  private coreStains!: PIXI.Container;
  private coreWrap!: PIXI.Container;

  private _blobH: BlobHarmonic[] = [];
  private _blobM = 64;
  private _blobR: Float32Array;
  private _blobV: Float32Array;
  private _blobTmp: Float32Array;
  private _blobX: Float32Array;
  private _blobY: Float32Array;
  private _coreStains: Stain[] = [];
  private _parts: Particle[] = [];
  private _shocks: Shock[] = [];
  private _sparkPool: Spark[] = [];
  private _cometPool: Comet[] = [];
  private _beatPop = 0;
  private _bgFlash = 0;
  private _attack = 0;
  private _volPrev = 0;

  // layout
  private cx = 0;
  private cy = 0;
  private coreR = 0;
  private eqInner = 0;
  private barMax = 0;
  private _a1 = 0;
  private _a2 = 0;
  private _cg = 0;
  private _density = 1;
  private scene: 'mountains' | 'space' = 'mountains';
  private pal!: Palette;

  private snap = { palette: '', density: 0, scene: '' };

  private _fluidX = new Float32Array(128);
  private _fluidY = new Float32Array(128);
  private _waveX = new Float32Array(128);
  private _waveY = new Float32Array(128);

  constructor(app: PIXI.Application, audio: AudioEngine, ramp: string[]) {
    this.app = app;
    this.audio = audio;
    this.stage = app.stage;

    this.ramp = ramp.map(hexNum);
    this.texDot = radialTexture(128);
    this.texSpark = sparkTexture(96);
    this.texGlow = radialTexture(512, 0.0);

    this.bgLayer = new PIXI.Container();
    this.glowLayer = new PIXI.Container();
    this.stage.addChild(this.bgLayer, this.glowLayer);

    try {
      this.bloom = new AdvancedBloomFilter({ threshold: 0.42, bloomScale: 0.85, brightness: 1.02, blur: 5, quality: 3 });
      const bloomFilter: PIXI.Filter = this.bloom as unknown as PIXI.Filter;
      this.glowLayer.filters = [bloomFilter];
    } catch (_) {}

    try {
      this.rgb = new RGBSplitFilter([0, 0], [0, 0], [0, 0]);
      const rgbFilter: PIXI.Filter = this.rgb as unknown as PIXI.Filter;
      this.glowLayer.filters = [...(this.glowLayer.filters || []), rgbFilter];
    } catch (_) {}

    this._blobR = new Float32Array(this._blobM).fill(1);
    this._blobV = new Float32Array(this._blobM);
    this._blobTmp = new Float32Array(this._blobM);
    this._blobX = new Float32Array(this._blobM);
    this._blobY = new Float32Array(this._blobM);

    this._buildCenter();
  }

  parsePalette(arr: string[]): Palette {
    return {
      primary: hexNum(arr[0]), secondary: hexNum(arr[1]),
      bgTop: hexNum(arr[2]), bgBot: hexNum(arr[3]), accent: hexNum(arr[4]),
    };
  }

  rampColor(t: number): number {
    const R = this.ramp, n = R.length;
    let f = (t + this._cycle) % 1; if (f < 0) f += 1;
    const x = f * n;
    const i = Math.floor(x) % n;
    return mixNum(R[i], R[(i + 1) % n], x - Math.floor(x));
  }

  private _buildCenter() {
    const c = this.center = new PIXI.Container();
    this.glowLayer.addChild(c);

    this.aura2 = new PIXI.Sprite(this.texGlow);
    this.aura1 = new PIXI.Sprite(this.texGlow);
    [this.aura1, this.aura2].forEach((s) => {
      s.anchor.set(0.5);
      s.blendMode = PIXI.BLEND_MODES.ADD;
    });

    this.shock = new PIXI.Graphics();
    this.comets = new PIXI.Graphics();
    this.fluid = new PIXI.Graphics();
    this.eq = new PIXI.Graphics();
    this.wave = new PIXI.Graphics();
    this.bassRing = new PIXI.Graphics();
    this.particles = new PIXI.Container();
    this.sparkles = new PIXI.Container();

    this.coreGlow = new PIXI.Sprite(this.texGlow);
    this.coreGlow.anchor.set(0.5);
    this.coreGlow.blendMode = PIXI.BLEND_MODES.ADD;
    this.coreBlob = new PIXI.Graphics();
    this.coreStains = new PIXI.Container();
    this.coreWrap = new PIXI.Container();
    this.coreWrap.addChild(this.coreGlow, this.coreBlob, this.coreStains);

    const hrng = mulberry(1337);
    for (const k of [2, 3, 4, 5, 7, 9]) {
      this._blobH.push({ k, amp: 0.04 + hrng() * 0.085, spd: 0.16 + hrng() * 0.5, phase: hrng() * TAU });
    }

    this._coreStains = [];
    for (let i = 0; i < 5; i++) {
      const s = new PIXI.Sprite(this.texGlow);
      s.anchor.set(0.5);
      s.blendMode = PIXI.BLEND_MODES.ADD;
      this.coreStains.addChild(s);
      this._coreStains.push({
        spr: s,
        ax: 0.12 + Math.random() * 0.4, ay: 0.12 + Math.random() * 0.4,
        fx: 0.3 + Math.random() * 0.9, fy: 0.3 + Math.random() * 0.9,
        phx: Math.random() * TAU, phy: Math.random() * TAU,
        sz: 0.45 + Math.random() * 0.7, react: 0.5 + Math.random() * 1.0,
      });
    }

    c.addChild(this.aura2, this.aura1, this.shock, this.particles,
      this.fluid, this.bassRing, this.eq, this.wave, this.coreWrap, this.comets, this.sparkles);

    this.coreTween?.kill();
    this.coreTween = gsap.to(this.coreWrap.scale, {
      x: 1.045, y: 1.045, duration: 2.6, yoyo: true, repeat: -1, ease: 'sine.inOut',
    });

    this._shocks = [];
    this._sparkPool = [];
    this._cometPool = [];
    this._beatPop = 0;
    this._bgFlash = 0;
  }

  private _buildParticles(density: number) {
    this.particles.removeChildren();
    this._parts = [];
    const n = Math.round(96 * density);
    const tints = [this.pal.primary, this.pal.secondary, this.pal.accent];
    for (let i = 0; i < n; i++) {
      const darter = Math.random() < 0.42;
      const r = Math.random();
      const sz = darter ? (1.2 + r * 3) : (2 + r * 4.5);
      const s = new PIXI.Sprite(this.texDot);
      s.anchor.set(0.5);
      s.blendMode = PIXI.BLEND_MODES.ADD;
      s.tint = tints[i % 3];
      s.scale.set(sz / 64);
      this.particles.addChild(s);
      this._parts.push({
        spr: s, ang0: Math.random() * TAU, rad: 0.8 + Math.random() * 1.6,
        x: null, y: null, vx: 0, vy: 0,
        wAng: Math.random() * TAU,
        wTurn: darter ? 0.5 : 0.25,
        wander: darter ? 340 + Math.random() * 260 : 120 + Math.random() * 120,
        swirl: (Math.random() < 0.5 ? 1 : -1) * (darter ? 120 + Math.random() * 160 : 40 + Math.random() * 70),
        springK: darter ? 2.2 : 3.6,
        drag: darter ? 0.95 : 0.93,
        react: darter ? 1.8 + Math.random() * 1.8 : 0.5 + Math.random() * 0.8,
        base: 0.18 + Math.random() * 0.4, size: sz,
      });
    }
  }

  private _buildBackground() {
    this.bgLayer.removeChildren();
    const W = this.app.screen.width, H = this.app.screen.height;
    const p = this.pal;

    this.sky = new PIXI.Sprite(gradientTexture(p.bgTop, p.bgBot));
    this.sky.width = W; this.sky.height = H;
    this.bgLayer.addChild(this.sky);

    this.moonWrap = new PIXI.Container();
    this.bgLayer.addChild(this.moonWrap);
    this._moon = { x: W * (0.74 + Math.random() * 0.14), y: H * (0.2 + Math.random() * 0.12), r: Math.max(40, Math.min(W, H) * 0.07) };
    const halo = new PIXI.Sprite(this.texGlow);
    halo.anchor.set(0.5); halo.blendMode = PIXI.BLEND_MODES.ADD; halo.tint = 0xeaf2ff;
    halo.width = halo.height = this._moon.r * 14; halo.alpha = 0.16;
    const disc = new PIXI.Sprite(this.texGlow);
    disc.anchor.set(0.5); disc.blendMode = PIXI.BLEND_MODES.ADD; disc.tint = 0xffffff;
    disc.width = disc.height = this._moon.r * 4.2; disc.alpha = 0.5;
    const core = new PIXI.Graphics();
    core.beginFill(0xf3f7ff, 0.95); core.drawCircle(0, 0, this._moon.r); core.endFill();
    core.beginFill(p.primary, 0.06); core.drawCircle(0, 0, this._moon.r); core.endFill();
    this.moonWrap.position.set(this._moon.x, this._moon.y);
    this.moonWrap.addChild(halo, disc, core);
    this._moonHalo = halo; this._moonDisc = disc;

    this.clouds = new PIXI.Container();
    this.bgLayer.addChild(this.clouds);
    this._clouds = [];
    const cloudN = this.scene === 'space' ? 0 : 4;
    for (let i = 0; i < cloudN; i++) {
      const s = new PIXI.Sprite(this.texGlow);
      s.anchor.set(0.5); s.blendMode = PIXI.BLEND_MODES.ADD; s.tint = 0xc9d8ff;
      const w = (0.5 + Math.random() * 0.7) * W;
      s.width = w; s.height = w * (0.16 + Math.random() * 0.1);
      s.x = Math.random() * W; s.y = H * (0.12 + Math.random() * 0.34);
      s.alpha = 0.05 + Math.random() * 0.05;
      this.clouds.addChild(s);
      this._clouds.push({ spr: s, speed: (0.003 + Math.random() * 0.006) * W, baseA: s.alpha });
    }

    this.fog = new PIXI.Container();
    this.bgLayer.addChild(this.fog);
    this._fogBlobs = [];
    const fogTints = [p.primary, p.secondary, p.accent, p.secondary];
    const fogCount = this.scene === 'space' ? 5 : 3;
    for (let i = 0; i < fogCount; i++) {
      const s = new PIXI.Sprite(this.texGlow);
      s.anchor.set(0.5); s.blendMode = PIXI.BLEND_MODES.ADD;
      s.tint = fogTints[i % fogTints.length];
      const r = (0.4 + Math.random() * 0.5) * Math.max(W, H);
      s.width = s.height = r * 2;
      const y = this.scene === 'space' ? Math.random() * H : H * (0.18 + Math.random() * 0.5);
      s.y = y; s.x = Math.random() * W;
      s.alpha = 0.10 + Math.random() * 0.08;
      this.fog.addChild(s);
      this._fogBlobs.push({ spr: s, speed: (0.004 + Math.random() * 0.01) * (Math.random() < 0.5 ? 1 : -1) * W, baseA: s.alpha, baseY: y, bob: 8 + Math.random() * 26, phase: Math.random() * TAU });
    }

    this.auroraG = new PIXI.Graphics();
    this.auroraG.blendMode = PIXI.BLEND_MODES.ADD;
    this.bgLayer.addChild(this.auroraG);
    const space = this.scene === 'space';
    this._auroraBands = [
      { col: p.primary,   baseY: H * (space ? 0.34 : 0.26), amp: H * 0.05,  thick: H * 0.12, fx: 1.1, sp: 0.22,  a: 0.085 },
      { col: p.secondary, baseY: H * (space ? 0.22 : 0.17), amp: H * 0.06,  thick: H * 0.09, fx: 0.7, sp: -0.16, a: 0.07 },
      { col: p.accent,    baseY: H * (space ? 0.48 : 0.36), amp: H * 0.045, thick: H * 0.14, fx: 1.5, sp: 0.30,  a: 0.06 },
    ];

    this.stars = new PIXI.Container();
    this.bgLayer.addChild(this.stars);
    this._stars = [];
    const starN = Math.round((this.scene === 'space' ? 220 : 140) * this._density);
    const starBand = this.scene === 'space' ? H : H * 0.82;
    for (let i = 0; i < starN; i++) {
      const s = new PIXI.Sprite(this.texDot);
      s.anchor.set(0.5); s.blendMode = PIXI.BLEND_MODES.ADD;
      s.tint = Math.random() < 0.2 ? p.primary : 0xffffff;
      const sz = 0.6 + Math.random() * 2.2;
      s.scale.set(sz / 64);
      s.x = Math.random() * W; s.y = Math.random() * starBand;
      this.stars.addChild(s);
      this._stars.push({ spr: s, base: 0.25 + Math.random() * 0.6, tw: 0.5 + Math.random() * 2.5, ph: Math.random() * TAU, drift: 2 + Math.random() * 8 });
    }

    this.shootG = new PIXI.Graphics();
    this.shootG.blendMode = PIXI.BLEND_MODES.ADD;
    this.bgLayer.addChild(this.shootG);
    this._shoots = [];
    if (this._shootTimer == null) this._shootTimer = 1.5 + Math.random() * 3;

    this.mountains = new PIXI.Container();
    this.bgLayer.addChild(this.mountains);
    this._ridges = [];
    if (this.scene !== 'space') {
      const layers = [
        { mix: 0.70, ampF: 0.11, baseF: 0.60, speed: 2, seed: 5 },
        { mix: 0.55, ampF: 0.16, baseF: 0.70, speed: 4, seed: 11 },
        { mix: 0.34, ampF: 0.22, baseF: 0.80, speed: 9, seed: 47 },
        { mix: 0.14, ampF: 0.30, baseF: 0.93, speed: 16, seed: 83 },
      ];
      for (const L of layers) {
        let col = mixNum(p.bgBot, p.bgTop, L.mix);
        col = mixNum(col, p.primary, 0.08);
        const g = this._makeRidge(W, H, L, col);
        this.mountains.addChild(g);
        this._ridges.push({ g, speed: L.speed, vy: 0, yOff: 0, dim: 0xb9bdc9 });
      }
    }
  }

  private _makeRidge(W: number, H: number, L: { seed: number; ampF: number; baseF: number }, color: number): PIXI.Graphics {
    const g = new PIXI.Graphics();
    const rng = mulberry(L.seed);
    const phases = [rng() * TAU, rng() * TAU, rng() * TAU, rng() * TAU, rng() * TAU];
    const amp = H * L.ampF, baseY = H * L.baseF;
    const h = (x: number) => {
      const u = (x % W) / W * TAU;
      let v = 0.55 * Math.sin(u + phases[0]) + 0.22 * Math.sin(2 * u + phases[1]) +
        0.14 * Math.sin(3 * u + phases[2]) + 0.06 * Math.sin(5 * u + phases[3]) + 0.04 * Math.sin(7 * u + phases[4]);
      v = (v + 1) / 2;
      return Math.pow(v, 1.15) * amp;
    };
    g.beginFill(color, 1);
    g.moveTo(0, H);
    const step = Math.max(6, W / 160);
    for (let x = 0; x <= 2 * W; x += step) g.lineTo(x, baseY - h(x));
    g.lineTo(2 * W, H);
    g.closePath(); g.endFill();
    g.x = 0;
    return g;
  }

  applyConfig(cfg: VizConfig, force = false) {
    const palKey = cfg.palette.join(',');
    const densityChanged = force || cfg.density !== this.snap.density;
    const sceneChanged = force || cfg.scene !== this.snap.scene;
    const palChanged = force || palKey !== this.snap.palette;

    this._density = cfg.density || 1;
    this.scene = cfg.scene || 'mountains';

    if (palChanged) {
      this.pal = this.parsePalette(cfg.palette);
      this.aura1.tint = this.pal.primary;
      this.aura2.tint = this.pal.secondary;
      this.coreGlow.tint = 0xffffff;
      const st = [this.pal.primary, this.pal.secondary, this.pal.accent, 0xffffff, this.pal.secondary];
      this._coreStains.forEach((c, i) => { c.spr.tint = st[i % st.length]; });
    }
    if (palChanged || densityChanged) this._buildParticles(this._density);
    if (palChanged || sceneChanged || densityChanged) this._buildBackground();

    this.snap = { palette: palKey, density: cfg.density, scene: cfg.scene };
  }

  resize() {
    const W = this.app.screen.width, H = this.app.screen.height;
    this.cx = W / 2; this.cy = H * (this.scene === 'space' ? 0.5 : 0.46);
    this.center.position.set(this.cx, this.cy);
    const m = Math.min(W, H);
    this.coreR = Math.max(30, m * 0.064);
    this.eqInner = this.coreR * 2.5;
    this.barMax = this.coreR * 2.7;
    this._a1 = this.barMax * 3.0;
    this._a2 = this.barMax * 6.0;
    this._cg = this.coreR * 4.2;
    this.aura1.width = this.aura1.height = this._a1;
    this.aura2.width = this.aura2.height = this._a2;
    this.coreGlow.width = this.coreGlow.height = this._cg;
    if (this.bloom) this.glowLayer.filterArea = new PIXI.Rectangle(0, 0, W, H);
    this._buildBackground();
  }

  private _drawCoreBlob(dt: number, bass: number, mids: number, beat: boolean) {
    const M = this._blobM, R = this.coreR;
    const r = this._blobR, v = this._blobV, tmp = this._blobTmp;
    const sdt = Math.min(dt, 0.03);
    const K = 300, TENSION = 150, DAMP = 0.9;
    const baseScale = 1 + bass * 0.4 + this._beatPop * 0.18;
    for (let i = 0; i < M; i++) {
      const a = (i / M) * TAU;
      let target = 1;
      for (const h of this._blobH) target += h.amp * Math.sin(h.k * a + h.phase + this.t * h.spd);
      target += mids * 0.16 * Math.sin(a * 6 + this.t * 1.7);
      target *= baseScale;
      const left = r[(i - 1 + M) % M], right = r[(i + 1) % M];
      const accel = K * (target - r[i]) + TENSION * ((left + right) * 0.5 - r[i]);
      let nv = (v[i] + accel * sdt) * DAMP;
      if (nv > 9) nv = 9; else if (nv < -9) nv = -9;
      v[i] = nv;
      let nr = r[i] + nv * sdt;
      if (nr < 0.45) nr = 0.45; else if (nr > 2.3) nr = 2.3;
      tmp[i] = nr;
    }
    r.set(tmp);
    if (beat) {
      const s = this.audio.beatStrength || 0.6;
      const c1 = (Math.random() * M) | 0;
      for (let j = -3; j <= 3; j++) v[(c1 + j + M) % M] += s * (1.8 - Math.abs(j) * 0.22);
      const c2 = (Math.random() * M) | 0;
      for (let j = -2; j <= 2; j++) v[(c2 + j + M) % M] += s * (1.2 - Math.abs(j) * 0.2);
      for (let i = 0; i < M; i++) v[i] += s * 0.35;
    }
    const g = this.coreBlob; g.clear();
    const xs = this._blobX, ys = this._blobY;
    for (let i = 0; i < M; i++) {
      const a = (i / M) * TAU, rad = R * r[i];
      xs[i] = Math.cos(a) * rad; ys[i] = Math.sin(a) * rad;
    }
    const path = (scale: number) => {
      g.moveTo((xs[M - 1] + xs[0]) * 0.5 * scale, (ys[M - 1] + ys[0]) * 0.5 * scale);
      for (let i = 0; i < M; i++) {
        const ni = (i + 1) % M;
        g.quadraticCurveTo(xs[i] * scale, ys[i] * scale, (xs[i] + xs[ni]) * 0.5 * scale, (ys[i] + ys[ni]) * 0.5 * scale);
      }
      g.closePath();
    };
    g.beginFill(this.pal.primary, 0.34 + bass * 0.2);
    g.lineStyle({ width: Math.max(1.5, R * 0.05), color: 0xffffff, alpha: 0.6 });
    path(1); g.endFill(); g.lineStyle(0);
    g.beginFill(0xffffff, 0.7);
    path(0.58); g.endFill();
  }

  private _updateCoreStains(dt: number, vol: number, bass: number, mids: number) {
    void dt;
    const R = this.coreR;
    for (const c of this._coreStains) {
      c.spr.x = Math.sin(this.t * c.fx + c.phx) * c.ax * R;
      c.spr.y = Math.cos(this.t * c.fy + c.phy) * c.ay * R;
      const sz = R * c.sz * (0.8 + bass * c.react + mids * 0.4);
      c.spr.width = c.spr.height = sz * 2;
      c.spr.alpha = 0.16 + vol * 0.4 + bass * 0.32 * c.react;
    }
  }

  update(dt: number, cfg: VizConfig) {
    this.t += dt;
    const a = this.audio;
    const intensity = cfg.intensity || 1;
    const bassGain = cfg.bass || 1;
    const b = a.bands;
    const bass = clamp(b.bass * bassGain, 0, 1.4);
    const vol = b.volume;

    const dv = Math.max(0, vol - this._volPrev);
    this._volPrev = vol;
    this._attack = Math.max(this._attack * 0.86, dv * 6);

    if (cfg.colorCycle) this._cycle += dt * (0.02 + vol * 0.06) * (cfg.cycleSpeed || 1);

    if (this.rgb) {
      if (a.beat && (a.beatStrength || 0) > 0.5) this._abr = Math.max(this._abr, (a.beatStrength - 0.4));
      this._abr = lerp(this._abr, 0, 0.14);
      const px = this._abr * 5 * (cfg.aberration != null ? cfg.aberration : 1);
      this.rgb.red = [px, -px * 0.4];
      this.rgb.blue = [-px, px * 0.4];
      this.rgb.green = [0, 0];
    }

    if (this.bloom && (this.bloom as any).bloomScale != null) {
      const target = (0.5 + vol * 1.2) * (cfg.bloom || 1);
      (this.bloom as any).bloomScale = lerp((this.bloom as any).bloomScale, target, 0.1);
    }

    this.aura1.scale.set((this._a1 / 512) * (0.85 + bass * 0.6));
    this.aura1.alpha = 0.13 + vol * 0.4;
    this.aura2.scale.set((this._a2 / 512) * (0.9 + vol * 0.4));
    this.aura2.alpha = 0.07 + vol * 0.22;
    this.coreGlow.alpha = 0.32 + vol * 0.42 + this._beatPop * 0.4;

    if (a.beat) this._beatPop = Math.max(this._beatPop, a.beatStrength || 0.6);
    this._beatPop = lerp(this._beatPop, 0, 0.12);
    if (a.beat) this._bgFlash = Math.max(this._bgFlash, (a.beatStrength || 0.6) * 0.8);
    this._bgFlash = lerp(this._bgFlash, 0, 0.08);
    const popScale = 1 + this._beatPop * 0.06 * bassGain;
    this.coreGlow.scale.set((this._cg / 512) * popScale);

    this._drawCoreBlob(dt, bass, b.mids, a.beat);
    this._updateCoreStains(dt, vol, bass, b.mids);

    if (a.beat) this._shocks.push({ r: this.coreR * 1.4, a: 0.4 * (a.beatStrength || 0.6), w: Math.max(2, this.coreR * 0.12) });
    this._drawShocks(dt);

    this._drawFluid(intensity, vol);
    this._drawEq(cfg, bass, b.mids, intensity);
    this._drawWave(b.mids, intensity);
    this._drawBassRing(bass);
    this._updateComets(dt, bass);
    this._updateParticles(dt, vol, bass);
    this._updateSparkles(dt, b.highs);
    this._updateBackground(dt, vol, bass);
  }

  private _drawShocks(dt: number) {
    const g = this.shock; g.clear();
    const grow = Math.max(this.app.screen.width, this.app.screen.height) * 0.55;
    for (let i = this._shocks.length - 1; i >= 0; i--) {
      const s = this._shocks[i];
      s.r += grow * dt; s.a -= dt * 0.7; s.w *= (1 - dt * 0.6);
      if (s.a <= 0) { this._shocks.splice(i, 1); continue; }
      g.lineStyle({ width: Math.max(0.5, s.w), color: this.pal.secondary, alpha: s.a });
      g.drawCircle(0, 0, s.r);
    }
  }

  private _drawEq(cfg: VizConfig, bass: number, mids: number, intensity: number) {
    void mids;
    const g = this.eq; g.clear();
    const spec = this.audio.spectrum;
    const half = 64;
    const inner = this.eqInner + bass * this.coreR * 0.5;
    const barW = Math.max(3, (TAU * inner / (half * 2)) * 0.78);
    const usable = 250;
    const anchor = -Math.PI / 2;
    void cfg;

    for (let k = 0; k <= half; k++) {
      const t = k / half;
      const bin = Math.floor(Math.pow(t, 1.5) * usable) + 2;
      const v = spec[Math.min(bin, spec.length - 1)] || 0;
      const len = 5 + v * this.barMax * 1.25 * intensity;
      const color = this.rampColor(t);
      for (const side of [-1, 1]) {
        if (side === 1 && (k === 0 || k === half)) continue;
        const ang = anchor + side * t * Math.PI;
        const c = Math.cos(ang), s = Math.sin(ang);
        g.lineStyle({ width: barW * 1.7, color, alpha: 0.22 + v * 0.3 });
        g.moveTo(c * inner, s * inner);
        g.lineTo(c * (inner + len), s * (inner + len));
        g.lineStyle({ width: barW, color, alpha: 0.98 });
        g.moveTo(c * inner, s * inner);
        g.lineTo(c * (inner + len), s * (inner + len));
      }
    }
  }

  private _drawFluid(intensity: number, vol: number) {
    const g = this.fluid; g.clear();
    const spec = this.audio.spectrum;
    const M = 128;
    const base = this.eqInner * 0.99;
    const amp = this.barMax * 0.6 * intensity;
    const usable = 250;
    const xs = this._fluidX;
    const ys = this._fluidY;
    for (let i = 0; i < M; i++) {
      const d = i / M;
      const t = d <= 0.5 ? d * 2 : (1 - d) * 2;
      const bin = Math.floor(Math.pow(t, 1.5) * usable) + 2;
      const v = spec[Math.min(bin, spec.length - 1)] || 0;
      const wob = Math.sin(i * 0.6 + this.t * 1.3) * this.coreR * 0.05
                + Math.sin(i * 0.21 - this.t * 0.8) * this.coreR * 0.04;
      const r = base + v * amp + wob;
      const ang = -Math.PI / 2 + d * TAU;
      xs[i] = Math.cos(ang) * r;
      ys[i] = Math.sin(ang) * r;
    }
    g.beginFill(this.pal.primary, 0.07 + vol * 0.10);
    g.lineStyle({ width: 2, color: this.pal.primary, alpha: 0.32 + vol * 0.35 });
    g.moveTo((xs[M - 1] + xs[0]) / 2, (ys[M - 1] + ys[0]) / 2);
    for (let i = 0; i < M; i++) {
      const ni = (i + 1) % M;
      g.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[ni]) / 2, (ys[i] + ys[ni]) / 2);
    }
    g.closePath(); g.endFill();
  }

  private _drawWave(mids: number, intensity: number) {
    const g = this.wave; g.clear();
    const spec = this.audio.spectrum;
    const baseR = this.eqInner * 0.97;
    const steps = 128;
    const xs = this._waveX;
    const ys = this._waveY;
    for (let i = 0; i < steps; i++) {
      const f = i / steps;
      const t = f <= 0.5 ? f * 2 : (1 - f) * 2;
      const bin = 14 + Math.floor(Math.pow(t, 1.3) * 150);
      const wob = (spec[Math.min(bin, spec.length - 1)] || 0) * this.coreR * 1.1 * intensity;
      const ang = f * TAU - Math.PI / 2;
      const r = baseR + Math.sin(ang * 5 + this.t * 1.4) * 2 + wob;
      xs[i] = Math.cos(ang) * r;
      ys[i] = Math.sin(ang) * r;
    }
    const drawLoop = (w: number, col: number, alpha: number) => {
      g.lineStyle({ width: w, color: col, alpha });
      g.moveTo((xs[steps - 1] + xs[0]) * 0.5, (ys[steps - 1] + ys[0]) * 0.5);
      for (let i = 0; i < steps; i++) {
        const ni = (i + 1) % steps;
        g.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[ni]) * 0.5, (ys[i] + ys[ni]) * 0.5);
      }
      g.closePath();
    };
    const thick = 2.5 + mids * 6 * intensity;
    drawLoop(thick + 9, this.pal.primary, 0.18 + mids * 0.25);
    drawLoop(thick, 0xffffff, 0.95);
  }

  private _drawBassRing(bass: number) {
    const g = this.bassRing; g.clear();
    const r = this.coreR * 1.45 + bass * this.coreR * 1.25;
    g.lineStyle({ width: 2.5 + bass * 7, color: this.pal.secondary, alpha: 0.35 + bass * 0.55 });
    g.drawCircle(0, 0, r);
  }

  private _updateComets(dt: number, bass: number) {
    const a = this.audio;
    if (a.beat && (a.beatStrength || 0) > 0.55) {
      const n = 1 + Math.floor((a.beatStrength - 0.5) * 4);
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * TAU;
        this._cometPool.push({
          ang, r: this.eqInner + this.barMax * 0.5,
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
      const k = Math.min(1, c.life / c.max);
      const dx = Math.cos(c.ang), dy = Math.sin(c.ang);
      const hx = dx * c.r, hy = dy * c.r;
      const tx = dx * (c.r - c.len), ty = dy * (c.r - c.len);
      g.lineStyle({ width: 3, color: c.col, alpha: k });
      g.moveTo(hx, hy); g.lineTo((hx + tx) / 2, (hy + ty) / 2);
      g.lineStyle({ width: 1.6, color: c.col, alpha: k * 0.4 });
      g.lineTo(tx, ty);
      g.beginFill(0xffffff, k); g.drawCircle(hx, hy, 2.4); g.endFill();
    }
  }

  private _updateParticles(dt: number, vol: number, bass: number) {
    const beat = this.audio.beat ? (this.audio.beatStrength || 0.6) : 0;
    const maxR = this.barMax * 3.0, minR = this.eqInner * 0.7;
    for (const p of this._parts) {
      if (p.x === null) {
        const hr = this.barMax * p.rad;
        p.x = Math.cos(p.ang0) * hr;
        p.y = Math.sin(p.ang0) * hr;
      }
      let d = Math.hypot(p.x!, p.y!) || 0.0001;
      const ux = p.x! / d, uy = p.y! / d, tx = -uy, ty = ux;
      p.wAng += (Math.random() - 0.5) * p.wTurn;
      let ax = Math.cos(p.wAng) * p.wander;
      let ay = Math.sin(p.wAng) * p.wander;
      const err = this.barMax * p.rad - d;
      ax += ux * err * p.springK; ay += uy * err * p.springK;
      ax += tx * p.swirl; ay += ty * p.swirl;
      const push = bass * p.react * this.coreR * 7;
      ax += ux * push; ay += uy * push;
      if (beat) { const imp = beat * p.react * this.coreR * 12; p.vx += ux * imp; p.vy += uy * imp; }
      p.vx = (p.vx + ax * dt) * p.drag;
      p.vy = (p.vy + ay * dt) * p.drag;
      let sp = Math.hypot(p.vx, p.vy);
      if (sp > 700) { const k = 700 / sp; p.vx *= k; p.vy *= k; sp = 700; }
      p.x! += p.vx * dt; p.y = p.y! + p.vy * dt;
      d = Math.hypot(p.x!, p.y!);
      if (d > maxR) { const k = maxR / d; p.x = p.x! * k; p.y = p.y! * k; p.vx *= 0.5; p.vy *= 0.5; }
      else if (d < minR) { const k = minR / d; p.x = p.x! * k; p.y = p.y! * k; }
      p.spr.x = p.x!; p.spr.y = p.y!;
      const speedN = Math.min(1, sp / 320);
      p.spr.alpha = p.base * (0.4 + vol * 0.7 + bass * 0.8 + speedN * 0.3);
      p.spr.scale.set((p.size / 64) * (1 + bass * 0.9 + speedN * 0.4));
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
    s.anchor.set(0.5); s.blendMode = PIXI.BLEND_MODES.ADD;
    s.tint = Math.random() < 0.5 ? 0xffffff : this.pal.primary;
    const ang = Math.random() * TAU;
    const rad = this.eqInner + Math.random() * this.barMax;
    const size = 8 + Math.random() * 18;
    s.x = Math.cos(ang) * rad; s.y = Math.sin(ang) * rad;
    this.sparkles.addChild(s);
    this._sparkPool.push({ spr: s, ang, rad, vr: 10 + Math.random() * 40, life: 0.5 + Math.random() * 0.5, max: 1, size });
    if (this._sparkPool.length > 90) {
      const old = this._sparkPool.shift()!;
      old.spr.destroy();
    }
  }

  private _updateBackground(dt: number, vol: number, bass: number) {
    const W = this.app.screen.width, H = this.app.screen.height;
    const flash = this._bgFlash || 0;
    if (this._moonHalo) {
      this._moonHalo.alpha = 0.14 + vol * 0.18 + flash * 0.2;
      const s = (this._moon.r * 14 / 512) * (1 + vol * 0.08 + flash * 0.12);
      this._moonHalo.scale.set(s);
      this._moonDisc!.alpha = 0.45 + vol * 0.25 + flash * 0.2;
    }
    if (this._clouds) for (const c of this._clouds) {
      c.spr.x += c.speed * dt;
      if (c.spr.x > W + c.spr.width / 2) c.spr.x = -c.spr.width / 2;
      c.spr.alpha = c.baseA * (0.7 + vol * 0.6 + flash * 0.5);
    }
    if (this._fogBlobs) for (const f of this._fogBlobs) {
      f.spr.x += f.speed * dt;
      const r = f.spr.width / 2;
      if (f.spr.x < -r) f.spr.x = W + r;
      if (f.spr.x > W + r) f.spr.x = -r;
      f.spr.y = f.baseY + Math.sin(this.t * 0.2 + f.phase) * f.bob;
      f.spr.alpha = f.baseA * (0.6 + vol * 1.0 + flash * 0.5);
    }
    if (this._stars) for (const st of this._stars) {
      st.spr.alpha = st.base * (0.4 + 0.55 * (0.5 + 0.5 * Math.sin(this.t * st.tw + st.ph))) + flash * 0.3 * st.base;
      st.spr.x -= st.drift * dt;
      if (st.spr.x < -4) st.spr.x = W + 4;
    }
    this._drawAurora(vol, flash);
    this._updateShoots(dt, W, H);
    const surge = Math.min(2.2, this._attack || 0);
    if (this._ridges) for (const rg of this._ridges) {
      if (this.audio.beat) rg.vy -= (this.audio.beatStrength || 0.6) * (5 + rg.speed * 1.3);
      if (surge > 0.25) rg.vy -= surge * (3 + rg.speed * 0.9);
      rg.vy += (-rg.yOff * 30 - rg.vy * 7.5) * dt;
      rg.yOff += rg.vy * dt;
      rg.g.x = -((this.t * rg.speed) % W) + Math.sin(this.t * 0.15 + rg.speed) * 4;
      rg.g.y = Math.sin(this.t * 0.4) * 2 + bass * (4 + rg.speed) * 0.7 + rg.yOff;
      const lift = Math.min(1, Math.max(0, -rg.yOff / 20));
      const bri = Math.min(1, bass * 0.6 + flash * 0.8 + surge * 0.7 + lift * 0.6);
      rg.g.tint = mixNum(rg.dim, 0xffffff, bri);
    }
  }

  private _drawAurora(vol: number, flash: number) {
    if (!this._auroraBands) return;
    const g = this.auroraG; g.clear();
    const W = this.app.screen.width;
    const step = Math.max(10, W / 70);
    const surge = Math.min(2.2, this._attack || 0);
    for (const b of this._auroraBands) {
      const a = b.a * (0.45 + vol * 1.05 + flash * 0.8 + surge * 1.3);
      if (a <= 0.002) continue;
      const ampM = b.amp * (1 + surge * 1.7 + flash * 0.5);
      g.beginFill(b.col, a);
      const pts: [number, number][] = [];
      for (let x = 0; x <= W; x += step) {
        const wob = Math.sin(x * 0.004 * b.fx + this.t * b.sp) * ampM
                  + Math.sin(x * 0.011 - this.t * b.sp * 1.6) * ampM * 0.45;
        pts.push([x, b.baseY - surge * 16 + wob]);
      }
      g.moveTo(pts[0][0], pts[0][1]);
      for (const pt of pts) g.lineTo(pt[0], pt[1]);
      for (let i = pts.length - 1; i >= 0; i--) {
        const th = b.thick * (0.55 + 0.45 * Math.sin(pts[i][0] * 0.005 + this.t * 0.5)) * (1 + surge * 0.5);
        g.lineTo(pts[i][0], pts[i][1] + th);
      }
      g.closePath(); g.endFill();
    }
  }

  private _updateShoots(dt: number, W: number, H: number) {
    if (this._shootTimer == null) this._shootTimer = 2;
    this._shootTimer -= dt;
    if (this._shootTimer <= 0) {
      this._shootTimer = 2.2 + Math.random() * 4.5;
      const dir = Math.random() < 0.5 ? -1 : 1;
      const sp = 520 + Math.random() * 620;
      const a = (0.22 + Math.random() * 0.16) * Math.PI;
      this._shoots.push({
        x: dir < 0 ? W * (0.5 + Math.random() * 0.5) : W * Math.random() * 0.5,
        y: H * (0.04 + Math.random() * 0.34),
        vx: -dir * Math.cos(a) * sp, vy: Math.sin(a) * sp,
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
      const k = Math.min(1, s.life / s.max);
      const mag = Math.hypot(s.vx, s.vy) || 1;
      const ux = s.vx / mag, uy = s.vy / mag;
      const midX = s.x - ux * s.len * 0.5, midY = s.y - uy * s.len * 0.5;
      const tailX = s.x - ux * s.len, tailY = s.y - uy * s.len;
      g.lineStyle({ width: 2.2, color: s.col, alpha: k });
      g.moveTo(s.x, s.y); g.lineTo(midX, midY);
      g.lineStyle({ width: 1.3, color: s.col, alpha: k * 0.4 });
      g.lineTo(tailX, tailY);
      g.beginFill(s.col, k); g.drawCircle(s.x, s.y, 1.8); g.endFill();
    }
  }

  dispose() {
    this.coreTween?.kill();
    this.coreTween = undefined;
    if (this.bgLayer.parent) this.bgLayer.parent.removeChild(this.bgLayer);
    if (this.glowLayer.parent) this.glowLayer.parent.removeChild(this.glowLayer);
    this.bgLayer.destroy({ children: true });
    this.glowLayer.destroy({ children: true });
    this._clouds = [];
    this._fogBlobs = [];
    this._auroraBands = [];
    this._stars = [];
    this._shoots = [];
    this._ridges = [];
    this._parts = [];
    this._shocks = [];
    this._sparkPool = [];
    this._cometPool = [];
    this._coreStains = [];
  }
}
