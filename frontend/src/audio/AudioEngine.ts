import { clamp, lerp } from '../viz/util';
import type { AudioBands } from '../viz/types';

const BINS = 512;
const DEFAULT_FADE_OUT_MS = 2500;
const DEFAULT_FADE_IN_MS = 2500;
const userGestureRequiredMessage = 'audio requires a user gesture';

interface AudioEngineOptions {
  allowAutoplay?: boolean;
}

type BrowserUserActivation = {
  isActive?: boolean;
  hasBeenActive?: boolean;
};

interface PlaybackChannel {
  audioEl: HTMLAudioElement;
  mediaSource: MediaElementAudioSourceNode;
  gain: GainNode;
}

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
  private _channelA: PlaybackChannel | null = null;
  private _channelB: PlaybackChannel | null = null;
  private _activeChannel: PlaybackChannel | null = null;
  private _real: Uint8Array<ArrayBuffer> = new Uint8Array(BINS) as Uint8Array<ArrayBuffer>;
  private _t = 0;
  private _disposed = false;
  private _allowAutoplay: boolean;

  constructor(options: AudioEngineOptions = {}) {
    this._allowAutoplay = options.allowAutoplay === true;
  }

  get allowAutoplay() {
    return this._allowAutoplay;
  }

  private _ensureCtx() {
    if (this._disposed) return;
    if (this.ctx) return;
    this._assertCanStartAudio();

    const AC = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AC();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.82;
    this._real = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.analyser.connect(this.ctx.destination);
  }

  async resume() {
    if (this._disposed) return;
    if (this.ctx && this.ctx.state === 'suspended') {
      this._assertCanStartAudio();
      await this.ctx.resume();
    }
  }

  private _assertCanStartAudio() {
    if (this.ctx && this.ctx.state !== 'suspended') return;
    if (this._allowAutoplay) return;
    if (this._hasUserActivation()) return;
    throw new Error(userGestureRequiredMessage);
  }

  private _hasUserActivation() {
    const activation = (navigator as Navigator & { userActivation?: BrowserUserActivation }).userActivation;
    if (!activation) return true;
    return activation.isActive === true || activation.hasBeenActive === true;
  }

  private _ensureChannel(channel?: PlaybackChannel | null): PlaybackChannel {
    this._ensureCtx();
    if (!this.ctx || !this.analyser) throw new Error('audio engine disposed');
    if (channel) return channel;

    const audioEl = new Audio();
    audioEl.autoplay = this._allowAutoplay;
    audioEl.crossOrigin = 'anonymous';
    audioEl.preload = 'auto';
    const mediaSource = this.ctx.createMediaElementSource(audioEl);
    const gain = this.ctx.createGain();
    gain.gain.value = 1;
    mediaSource.connect(gain);
    gain.connect(this.analyser);

    return { audioEl, mediaSource, gain };
  }

  private _nextChannel(): PlaybackChannel {
    if (!this._channelA) {
      this._channelA = this._ensureChannel(this._channelA);
    }
    if (!this._channelB) {
      this._channelB = this._ensureChannel(this._channelB);
    }

    if (!this._activeChannel) return this._channelA;
    return this._activeChannel === this._channelA ? this._channelB : this._channelA;
  }

  private _activeAudioElement() {
    return this._activeChannel?.audioEl ?? null;
  }

  private _setChannelGain(channel: PlaybackChannel | null, value: number) {
    if (!channel) return;
    const clamped = clamp(value, 0, 1);
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    channel.gain.gain.setValueAtTime(clamped, now);
  }

  private _fadeChannelTo(channel: PlaybackChannel | null, value: number, durationMs: number): Promise<void> {
    if (!channel || !this.ctx) return Promise.resolve();

    const clamped = clamp(value, 0, 1);
    const now = this.ctx.currentTime;
    const durationSec = Math.max(0, durationMs) / 1000;
    const gain = channel.gain.gain;

    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    if (durationSec === 0) {
      gain.setValueAtTime(clamped, now);
      return Promise.resolve();
    }

    gain.linearRampToValueAtTime(clamped, now + durationSec);
    return new Promise((resolve) => {
      window.setTimeout(resolve, Math.max(0, Math.ceil(durationMs)));
    });
  }

  private _stopChannel(channel: PlaybackChannel | null) {
    if (!channel) return;
    channel.audioEl.pause();
    channel.audioEl.onended = null;
    channel.audioEl.onerror = null;
    channel.audioEl.removeAttribute('src');
    channel.audioEl.load();
    this._setChannelGain(channel, 0);
  }

  async playStream(
    streamUrl: string,
    sourceName: string,
    handlers: { onEnded?: () => void; onError?: (error: Event) => void } = {},
  ): Promise<void> {
    await this.resume();
    const outgoing = this._activeChannel;
    const incoming = this._nextChannel();
    const wasPlaying = !!(outgoing && this.playing && !outgoing.audioEl.paused);
    const hadSource = this.mode === 'backend' && !!outgoing?.audioEl.src;

    this._setChannelGain(incoming, 0);
    incoming.audioEl.onended = null;
    incoming.audioEl.onerror = null;
    incoming.audioEl.pause();
    incoming.audioEl.loop = false;
    incoming.audioEl.onended = handlers.onEnded ?? null;
    incoming.audioEl.onerror = handlers.onError ? event => handlers.onError?.(event instanceof Event ? event : new Event('error')) : null;
    incoming.audioEl.src = streamUrl;
    incoming.audioEl.load();
    this.mode = 'backend';
    this.hasUserSource = true;
    this.sourceName = sourceName;
    this._activeChannel = incoming;
    try {
      await incoming.audioEl.play();
      this.playing = true;
      const fadeIn = this._fadeChannelTo(incoming, 1, DEFAULT_FADE_IN_MS);
      const fadeOut = wasPlaying ? this._fadeChannelTo(outgoing, 0, DEFAULT_FADE_OUT_MS) : Promise.resolve();
      await Promise.all([fadeIn, fadeOut]);

      if (wasPlaying) {
        this._stopChannel(outgoing);
      }
    } catch (error) {
      this._stopChannel(incoming);
      this._activeChannel = outgoing;
      if (outgoing && wasPlaying) {
        this._setChannelGain(outgoing, 1);
        this.playing = true;
      } else {
        this.playing = false;
      }
      this.mode = hadSource ? 'backend' : 'idle';
      throw error;
    }
  }

  togglePlay(): boolean {
    const active = this._activeAudioElement();
    if (this.mode === 'backend' && active) {
      if (active.paused) { active.play(); this.playing = true; }
      else {
        active.pause();
        this.playing = false;
      }
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

    if (this._channelA) {
      this._channelA.audioEl.pause();
      this._channelA.audioEl.onended = null;
      this._channelA.audioEl.onerror = null;
      this._channelA.audioEl.removeAttribute('src');
      this._channelA.audioEl.load();
      this._channelA.mediaSource.disconnect();
      this._channelA.gain.disconnect();
    }
    if (this._channelB) {
      this._channelB.audioEl.pause();
      this._channelB.audioEl.onended = null;
      this._channelB.audioEl.onerror = null;
      this._channelB.audioEl.removeAttribute('src');
      this._channelB.audioEl.load();
      this._channelB.mediaSource.disconnect();
      this._channelB.gain.disconnect();
    }
    this._channelA = null;
    this._channelB = null;
    this._activeChannel = null;
    this.analyser?.disconnect();
    this.analyser = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') void ctx.close();
  }
}
