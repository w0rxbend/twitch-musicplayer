/* OscilloscopeVisualizer.ts — glowing audio-spectrum waveform.
 *
 * A single horizontal oscilloscope line rendered from the analyser's
 * time-domain data. Two chromatically-offset strokes (cyan lifted up, magenta
 * dropped down) with a bright white core, wrapped in bloom, over a field of
 * drifting particle dots — matching the reference "audio wave" artwork.
 *
 * Design notes:
 *   - The waveform is edge-tapered with a sine window so it fades to the centre
 *     line at both ends (the calm-to-active-to-calm silhouette).
 *   - Every polyline is drawn with midpoint-quadratic smoothing (no raw edges),
 *     round caps/joins, and multiple stroke passes (wide→crisp) so the bloom
 *     filter has soft energy to spread.
 *   - When the signal is quiet (idle / between tracks) a gentle synthesized
 *     undulation keeps the line alive so the page never looks dead.
 */
import * as PIXI from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters';
import { AudioAnalysisEngine } from '../audio/AudioAnalysisEngine';
import type { AudioEngine } from '../audio/AudioEngine';
import type { AudioFrame, Visualizer } from './types';
import { clamp, lerp, TAU } from './util';

interface OscilloscopeOptions {
  showBackground?: boolean;
  transparent?: boolean;
}

// Palette — cyan + magenta chromatic split with a white core, matching the art.
const CYAN = 0x2ee6f6;
const MAGENTA = 0xe152ff;
const WHITE = 0xeafcff;
const PARTICLE_COLORS = [CYAN, MAGENTA, WHITE, 0x8be9fd, 0xff92e0];

const WAVE_POINTS = 240;
const N_PARTICLES = 96;

interface Point { x: number; y: number }

interface Particle {
  bx: number; by: number;     // home position (fraction of width / band height)
  x: number; y: number;       // current pixel position
  drift: number;              // horizontal drift speed (px/s)
  bob: number;                // vertical bob amplitude (px)
  phase: number;
  r: number;                  // radius
  color: number;
  baseAlpha: number;
  twSpeed: number;            // twinkle speed
  kick: number;               // transient vertical velocity from beats
}

// A stroke pass: pixel width + alpha. Wide low-alpha passes feed the bloom;
// the final crisp pass is the visible line.
interface Pass { w: number; a: number }

// One colour layer of the waveform. dyDir shifts it vertically (chromatic
// split): cyan lifts up, magenta drops down, the white core stays centred.
// Core alphas are deliberately < 1 so the line reads as translucent.
interface WaveLayer { rgb: [number, number, number]; dyDir: number; passes: Pass[] }

const WAVE_LAYERS: WaveLayer[] = [
  // Cyan — lifted up.
  { rgb: [46, 230, 246], dyDir: -1, passes: [
    { w: 22, a: 0.05 }, { w: 12, a: 0.10 }, { w: 6, a: 0.20 }, { w: 3.2, a: 0.5 },
  ] },
  // Magenta — dropped down.
  { rgb: [225, 82, 255], dyDir: 1, passes: [
    { w: 22, a: 0.05 }, { w: 12, a: 0.10 }, { w: 6, a: 0.20 }, { w: 3.2, a: 0.5 },
  ] },
  // White core — centre line, translucent.
  { rgb: [234, 252, 255], dyDir: 0, passes: [
    { w: 4.5, a: 0.14 }, { w: 1.8, a: 0.62 },
  ] },
];

function drawSmooth(g: PIXI.Graphics, pts: Point[]) {
  if (pts.length < 2) return;
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const midx = (pts[i].x + pts[i + 1].x) / 2;
    const midy = (pts[i].y + pts[i + 1].y) / 2;
    g.quadraticCurveTo(pts[i].x, pts[i].y, midx, midy);
  }
  const n = pts.length;
  g.lineTo(pts[n - 1].x, pts[n - 1].y);
}

export class OscilloscopeVisualizer implements Visualizer {
  private app: PIXI.Application;
  private audio: AudioEngine;
  private analysis = new AudioAnalysisEngine();
  private showBackground: boolean;

  private root = new PIXI.Container();
  private bg = new PIXI.Graphics();
  private glowLayer = new PIXI.Container();
  private baselineGfx = new PIXI.Graphics();
  private waveGfx = new PIXI.Graphics();
  private particleGfx = new PIXI.Graphics();

  private smooth = new Float32Array(WAVE_POINTS);
  private disp = new Float32Array(WAVE_POINTS); // spatially-rounded copy of smooth
  private particles: Particle[] = [];
  private time = 0;
  private beatPulse = 0;
  private ampSmooth = 0;

  // Per-layer, per-pass gradient strokes. Each fades alpha → 0 at both ends
  // (the "gradient on the edges") and carries the layer colour at pass alpha in
  // the middle. Rebuilt on resize since the stops are in global pixel space.
  private gradients: (PIXI.FillGradient | null)[][] = [];

  private W = 1920;
  private H = 1080;
  private cx = 960;
  private cy = 540;

  constructor(app: PIXI.Application, audio: AudioEngine, options: OscilloscopeOptions = {}) {
    this.app = app;
    this.audio = audio;
    this.showBackground = options.showBackground ?? true;

    // Bloom over the reactive layers gives the neon halo.
    this.glowLayer.addChild(this.baselineGfx, this.particleGfx, this.waveGfx);
    try {
      this.glowLayer.filters = [
        new AdvancedBloomFilter({ threshold: 0.08, bloomScale: 1.7, brightness: 1, blur: 10, quality: 5 }),
      ];
      this.glowLayer.blendMode = 'add';
    } catch { /* filters unsupported — plain render still looks fine */ }

    this.root.addChild(this.bg, this.glowLayer);
    app.stage.addChild(this.root);

    this.resize();
    this.initParticles();
  }

  resize() {
    const r = this.app.renderer;
    this.W = r.width / r.resolution;
    this.H = r.height / r.resolution;
    this.cx = this.W / 2;
    this.cy = this.H / 2;
    this.drawBackground();
    this.buildGradients();
    // Re-anchor particles to the new band height.
    for (const p of this.particles) this.repositionParticle(p);
  }

  // (Re)build the horizontal gradient strokes: alpha 0 at the far left/right,
  // rising to the pass alpha across a soft plateau, so the line fades out at
  // both ends. On any failure we fall back to flat translucent strokes.
  private buildGradients() {
    const marginX = this.W * 0.06;
    const x0 = marginX;
    const x1 = this.W - marginX;
    this.gradients = WAVE_LAYERS.map(layer =>
      layer.passes.map(pass => {
        const [r, g, b] = layer.rgb;
        const col = (a: number) => `rgba(${r},${g},${b},${a})`;
        try {
          return new PIXI.FillGradient({
            type: 'linear',
            start: { x: x0, y: this.cy },
            end: { x: x1, y: this.cy },
            textureSpace: 'global',
            colorStops: [
              { offset: 0.00, color: col(0) },
              { offset: 0.14, color: col(pass.a) },
              { offset: 0.86, color: col(pass.a) },
              { offset: 1.00, color: col(0) },
            ],
          });
        } catch {
          return null; // fall back to a flat stroke for this pass
        }
      }),
    );
  }

  update(dt: number) {
    this.time += dt;
    const frame = this.analysis.update(this.audio);

    // Beat pulse envelope.
    if (frame.beat) this.beatPulse = Math.min(1.4, this.beatPulse + frame.beatStrength * 0.9);
    this.beatPulse *= Math.exp(-7 * dt);

    this.drawWaveform(dt, frame);
    this.updateParticles(dt, frame);
  }

  dispose() {
    this.root.destroy({ children: true });
  }

  // ── Background: subtle dark radial so the neon reads on any display ──────────
  private drawBackground() {
    this.bg.clear();
    if (!this.showBackground) return;
    // Layered translucent ellipses fake a soft radial glow behind the line.
    const bands: Pass[] = [
      { w: 1.0, a: 0.22 },
      { w: 0.66, a: 0.16 },
      { w: 0.4, a: 0.14 },
    ];
    for (const b of bands) {
      this.bg.ellipse(this.cx, this.cy, this.W * 0.55 * b.w, this.H * 0.32 * b.w);
      this.bg.fill({ color: 0x0a0f2a, alpha: b.a });
    }
  }

  // ── Waveform: two chromatic strokes + white core ────────────────────────────
  private drawWaveform(dt: number, frame: AudioFrame) {
    const td = frame.timeDomain;
    const tdLen = td.length;
    const activity = clamp(frame.rms * 3.4, 0, 1);

    // Overall amplitude reacts to loudness + beats, smoothed for fluid motion.
    const ampTarget = this.H * (0.10 + activity * 0.20 + this.beatPulse * 0.06);
    this.ampSmooth = lerp(this.ampSmooth, ampTarget, 0.12);
    const amp = this.ampSmooth;

    const marginX = this.W * 0.06;
    const spanX = this.W - marginX * 2;

    // Build target samples with edge taper + idle undulation, then smooth.
    // A softer idle (less high harmonic) plus the spatial pass below keeps the
    // line rounded rather than jagged.
    for (let i = 0; i < WAVE_POINTS; i++) {
      const t = i / (WAVE_POINTS - 1);
      const env = Math.pow(Math.sin(Math.PI * t), 0.9); // 0 at ends → 1 mid
      const sample = td[Math.min(tdLen - 1, Math.floor(t * (tdLen - 1)))] ?? 0;
      const idle =
        Math.sin(t * Math.PI * 2.4 - this.time * 1.2) * 0.36 +
        Math.sin(t * Math.PI * 5.0 + this.time * 0.8) * 0.13;
      const raw = sample * (0.55 + activity * 0.95) + idle * (1 - activity) * 0.55;
      const target = raw * env;
      this.smooth[i] = lerp(this.smooth[i], target, 0.32);
    }

    // Spatial low-pass (rounds peaks: [1 2 3 2 1]/9 over neighbours).
    for (let i = 0; i < WAVE_POINTS; i++) {
      const a = this.smooth[Math.max(0, i - 2)];
      const b = this.smooth[Math.max(0, i - 1)];
      const c = this.smooth[i];
      const d = this.smooth[Math.min(WAVE_POINTS - 1, i + 1)];
      const e = this.smooth[Math.min(WAVE_POINTS - 1, i + 2)];
      this.disp[i] = (a + 2 * b + 3 * c + 2 * d + e) / 9;
    }

    // Assemble the base polyline (centre positions).
    const base: Point[] = new Array(WAVE_POINTS);
    for (let i = 0; i < WAVE_POINTS; i++) {
      const t = i / (WAVE_POINTS - 1);
      base[i] = { x: marginX + t * spanX, y: this.cy - this.disp[i] * amp };
    }

    // Chromatic split widens slightly with energy.
    const split = 2.4 + activity * 4.5 + this.beatPulse * 3.0;

    const g = this.waveGfx;
    g.clear();

    WAVE_LAYERS.forEach((layer, li) => {
      const dy = layer.dyDir * split;
      const pts: Point[] = dy === 0 ? base : base.map(p => ({ x: p.x, y: p.y + dy }));
      layer.passes.forEach((pass, pi) => {
        drawSmooth(g, pts);
        const grad = this.gradients[li]?.[pi] ?? null;
        if (grad) {
          // Gradient carries the colour + edge-alpha fade; no flat colour.
          g.stroke({ width: pass.w, fill: grad, cap: 'round', join: 'round' });
        } else {
          const [r, gg, b] = layer.rgb;
          const color = (r << 16) | (gg << 8) | b;
          g.stroke({ color, width: pass.w, alpha: pass.a, cap: 'round', join: 'round' });
        }
      });
    });
  }

  // ── Particles: drifting neon dots around the waveform band ───────────────────
  private initParticles() {
    this.particles = [];
    for (let i = 0; i < N_PARTICLES; i++) {
      const p: Particle = {
        bx: Math.random(),
        by: (Math.random() * 2 - 1) * (0.35 + Math.random() * 0.65),
        x: 0, y: 0,
        drift: (Math.random() * 0.5 + 0.15) * (Math.random() < 0.5 ? -1 : 1) * 26,
        bob: 6 + Math.random() * 18,
        phase: Math.random() * TAU,
        r: 1.1 + Math.random() * 2.6,
        color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
        baseAlpha: 0.3 + Math.random() * 0.5,
        twSpeed: 0.6 + Math.random() * 2.4,
        kick: 0,
      };
      this.repositionParticle(p);
      this.particles.push(p);
    }
  }

  private repositionParticle(p: Particle) {
    const bandH = this.H * 0.26;
    p.x = p.bx * this.W;
    p.y = this.cy + p.by * bandH;
  }

  private updateParticles(dt: number, frame: AudioFrame) {
    const t = this.time;
    const bandH = this.H * 0.26;
    const g = this.particleGfx;
    g.clear();

    for (const p of this.particles) {
      // Horizontal drift with wrap-around.
      p.bx += (p.drift / this.W) * dt * (1 + frame.rms * 0.6);
      if (p.bx > 1.05) p.bx -= 1.1;
      if (p.bx < -0.05) p.bx += 1.1;

      // Beats give particles a soft outward vertical kick.
      if (frame.beat) p.kick += frame.beatStrength * (p.by >= 0 ? 1 : -1) * 34;
      p.kick *= Math.exp(-4 * dt);

      const bob = Math.sin(t * (0.6 + p.twSpeed * 0.4) + p.phase) * p.bob;
      p.x = p.bx * this.W;
      p.y = this.cy + p.by * bandH + bob + p.kick;

      // Twinkle.
      const tw = 0.55 + 0.45 * Math.sin(t * p.twSpeed + p.phase);
      const alpha = clamp(p.baseAlpha * tw * (0.7 + frame.rms * 0.8), 0, 1);
      const r = p.r * (1 + this.beatPulse * 0.25);

      // Soft halo + crisp core.
      g.circle(p.x, p.y, r * 2.4);
      g.fill({ color: p.color, alpha: alpha * 0.12 });
      g.circle(p.x, p.y, r);
      g.fill({ color: p.color, alpha });
    }
  }
}
