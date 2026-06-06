import { clamp, lerp } from '../viz/util';
import type { AudioBands } from '../viz/types';

const BINS = 512;

export class AudioEngine {
  mode: 'idle' | 'backend' = 'idle';
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  raw: Uint8Array = new Uint8Array(BINS);
  spectrum: Float32Array = new Float32Array(BINS);
  bands: AudioBands = { bass: 0, mids: 0, highs: 0, volume: 0 };
  beat = false;
  beatStrength = 0;
  hasUserSource = false;
  playing = false;
  sourceName = '';

  private _bassAvg = 0;
  private _beatCooldown = 0;
  private _audioEl: HTMLAudioElement | null = null;
  private _mediaSource: MediaElementAudioSourceNode | null = null;
  private _real: Uint8Array<ArrayBuffer> = new Uint8Array(BINS) as Uint8Array<ArrayBuffer>;
  private _t = 0;
  private _disposed = false;

  private _ensureCtx() {
    if (this._disposed) return;
    if (this.ctx) return;
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AC();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.82;
    this._real = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  async resume() {
    if (this._disposed) return;
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  private _ensureAudioElement() {
    this._ensureCtx();
    if (!this.ctx || !this.analyser) throw new Error('audio engine disposed');
    if (!this._audioEl) {
      this._audioEl = new Audio();
      this._audioEl.crossOrigin = 'anonymous';
      this._audioEl.preload = 'auto';
      this._mediaSource = this.ctx!.createMediaElementSource(this._audioEl);
      this._mediaSource.connect(this.analyser!);
      this.analyser!.connect(this.ctx!.destination);
    }
    this._audioEl.onended = null;
    this._audioEl.onerror = null;
    return this._audioEl;
  }

  async playStream(
    streamUrl: string,
    sourceName: string,
    handlers: { onEnded?: () => void; onError?: (error: Event) => void } = {},
  ): Promise<void> {
    const audioEl = this._ensureAudioElement();
    await this.resume();
    audioEl.pause();
    audioEl.loop = false;
    audioEl.onended = handlers.onEnded ?? null;
    audioEl.onerror = handlers.onError ? event => handlers.onError?.(event instanceof Event ? event : new Event('error')) : null;
    audioEl.src = streamUrl;
    this.mode = 'backend';
    this.hasUserSource = true;
    this.sourceName = sourceName;
    await audioEl.play();
    this.playing = true;
  }

  togglePlay(): boolean {
    if (this.mode === 'backend' && this._audioEl) {
      if (this._audioEl.paused) { this._audioEl.play(); this.playing = true; }
      else { this._audioEl.pause(); this.playing = false; }
    }
    return this.playing;
  }

  private _synth(dt: number, intensity: number) {
    this._t += dt;
    const t = this._t;
    const BPM = 76, beat = 60 / BPM, bar = beat * 4;
    const inBar = t % bar;
    const macro = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(t * 0.26));

    const kicks = [0, beat * 1.5, beat * 2, beat * 3.5];
    let kick = 0;
    for (const k of kicks) {
      let d = inBar - k; if (d < 0) d += bar;
      kick = Math.max(kick, Math.exp(-d / 0.14));
    }
    const sub = 0.5 + 0.5 * Math.sin(t * 2.0);

    let hat = 0;
    for (let i = 0; i < 8; i++) {
      const ht = i * (beat / 2) + beat / 4;
      let d = inBar - ht; if (d < 0) d += bar;
      hat = Math.max(hat, Math.exp(-d / 0.035));
    }

    const noise = (x: number) =>
      0.5 + 0.5 * (Math.sin(x * 12.9 + t * 1.7) * 0.5 + Math.sin(x * 41.3 - t * 0.9) * 0.3 + Math.sin(x * 91.1 + t * 3.1) * 0.2);

    for (let i = 0; i < BINS; i++) {
      const f = i / BINS;
      let v = 0;
      if (i < 44) {
        const shape = Math.pow(1 - i / 44, 1.4);
        v = (kick * 0.95 + sub * 0.32) * shape;
      } else if (i < 170) {
        const md = Math.pow(1 - (i - 44) / 126, 0.9);
        const mel = 0.22 + 0.18 * Math.sin(t * 1.3 + f * 9) + 0.14 * Math.sin(t * 0.5 + f * 22);
        v = (mel + 0.12 * noise(f)) * md * 0.9;
      } else {
        const hd = Math.pow(1 - (i - 170) / (BINS - 170), 1.3);
        v = (hat * 0.55 + 0.06 + 0.16 * noise(f * 3)) * hd * 0.7;
      }
      v = Math.max(0, v) * macro * intensity;
      this.raw[i] = clamp(v * 255, 0, 255);
    }
  }

  update(dt: number, intensity = 1) {
    if (this._disposed) return;
    const usingReal =
      this.mode === 'backend' &&
      this.analyser &&
      this.playing;

    if (usingReal) {
      this.analyser!.getByteFrequencyData(this._real);
      const n = Math.min(BINS, this._real.length);
      for (let i = 0; i < n; i++) this.raw[i] = this._real[i];
    } else {
      this._synth(dt, intensity);
    }

    for (let i = 0; i < BINS; i++) {
      const target = this.raw[i] / 255;
      const cur = this.spectrum[i];
      this.spectrum[i] = target > cur ? lerp(cur, target, 0.45) : lerp(cur, target, 0.12);
    }

    const avg = (a: number, b: number) => {
      let s = 0; for (let i = a; i < b; i++) s += this.raw[i];
      return s / ((b - a) * 255);
    };
    const k = 0.25;
    this.bands.bass = lerp(this.bands.bass, avg(1, 12), 0.4);
    this.bands.mids = lerp(this.bands.mids, avg(34, 120), k);
    this.bands.highs = lerp(this.bands.highs, avg(150, 360), 0.5);
    this.bands.volume = lerp(this.bands.volume, avg(1, 380), k);

    const instBass = avg(1, 12);
    this._bassAvg = lerp(this._bassAvg, instBass, 0.06);
    this._beatCooldown -= dt;
    this.beat = false;
    if (instBass > this._bassAvg * 1.32 && instBass > 0.18 && this._beatCooldown <= 0) {
      this.beat = true;
      this.beatStrength = clamp((instBass - this._bassAvg) * 3, 0.3, 1.2);
      this._beatCooldown = 0.16;
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.playing = false;
    this.mode = 'idle';
    this.hasUserSource = false;
    this.sourceName = '';

    if (this._audioEl) {
      this._audioEl.pause();
      this._audioEl.onended = null;
      this._audioEl.onerror = null;
      this._audioEl.removeAttribute('src');
      this._audioEl.load();
      this._audioEl = null;
    }
    this._mediaSource?.disconnect();
    this._mediaSource = null;
    this.analyser?.disconnect();
    this.analyser = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') void ctx.close();
  }
}
