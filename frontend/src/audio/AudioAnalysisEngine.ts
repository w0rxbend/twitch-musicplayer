/* AudioAnalysisEngine.ts — turns raw analyser output into display-ready series.
 *
 * Visualizers should never touch an AnalyserNode directly. Raw FFT output is a
 * poor fit for drawing, in three specific ways this module fixes:
 *
 *   1. FFT bins are linear in frequency, but hearing is logarithmic. Half of a
 *      linear spectrum covers 11–22 kHz, where there is almost nothing to see.
 *      Bands here are spaced by octave, so bass gets as much width as treble.
 *   2. Musical energy falls off steeply with frequency, so an untreated
 *      spectrum looks like a cliff. A tilt lifts the high end back up.
 *   3. Time-domain data must be reduced to bucket min/max, not sampled every
 *      Nth point. Point sampling of a waveform aliases: a loud passage becomes
 *      a thin flickering line instead of a solid block, because the samples
 *      land wherever the oscillation happens to be.
 *
 * The analyser used here is this module's own, tapped off the engine's node, so
 * its resolution and smoothing can suit waveform drawing without changing how
 * the existing scenes look.
 */
import type { AudioEngine } from './AudioEngine';
import type { AudioFrame } from '../viz/types';
import { buildLogBands, reduceEnvelope } from './analysisMath';

export interface AnalysisOptions {
  /** Number of log-spaced spectrum bands. */
  bands?: number;
  /** Number of waveform buckets across the display. */
  wavePoints?: number;
  /** Low edge of the band range, in hertz. */
  minHz?: number;
  /** High edge of the band range, in hertz. */
  maxHz?: number;
}

// 2048 samples is the sweet spot for waveform drawing: enough resolution that
// bucket min/max is meaningful at 60 fps, without the latency of a longer window.
const FFT_SIZE = 2048;
// Light smoothing only. The per-band attack/release below does the visual
// smoothing, and doing it twice makes bars feel sluggish and disconnected.
const SMOOTHING = 0.55;

const DEFAULTS = { bands: 64, wavePoints: 256, minHz: 30, maxHz: 16000 };

// Band envelope: snap upward, ease downward. Matches how a level meter behaves
// and how people expect a bar to react to a transient.
const BAND_ATTACK = 0.55;
const BAND_RELEASE = 0.14;
// Peak caps hang, then fall away.
const PEAK_FALL_PER_SEC = 0.55;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class AudioAnalysisEngine {
  private readonly nBands: number;
  private readonly nWave: number;
  private readonly minHz: number;
  private readonly maxHz: number;

  /** Our own analyser, created lazily once the engine has an audio graph. */
  private node: AnalyserNode | null = null;
  private nodeSource: AnalyserNode | null = null;

  private freqBytes = new Uint8Array(FFT_SIZE / 2);
  private timeBytes = new Uint8Array(FFT_SIZE);
  private timeFloat = new Float32Array(FFT_SIZE);

  /** Inclusive-exclusive bin range per band, rebuilt when the sample rate is known. */
  private bandLo: Int32Array;
  private bandHi: Int32Array;
  private bandTilt: Float32Array;
  private builtForRate = 0;

  private smoothed = { bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, rms: 0 };
  private peak = 0;
  private idlePhase = 0;

  private readonly frame: AudioFrame;

  constructor(options: AnalysisOptions = {}) {
    this.nBands = Math.max(4, options.bands ?? DEFAULTS.bands);
    this.nWave = Math.max(8, options.wavePoints ?? DEFAULTS.wavePoints);
    this.minHz = options.minHz ?? DEFAULTS.minHz;
    this.maxHz = options.maxHz ?? DEFAULTS.maxHz;

    this.bandLo = new Int32Array(this.nBands);
    this.bandHi = new Int32Array(this.nBands);
    this.bandTilt = new Float32Array(this.nBands);

    this.frame = {
      bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0,
      rms: 0, peak: 0, beat: false, beatStrength: 0,
      spectrum: new Float32Array(FFT_SIZE / 2),
      timeDomain: this.timeFloat,
      bands: new Float32Array(this.nBands),
      bandPeaks: new Float32Array(this.nBands),
      waveMin: new Float32Array(this.nWave),
      waveMax: new Float32Array(this.nWave),
      waveRms: new Float32Array(this.nWave),
    };
  }

  /** Number of bands this instance produces. */
  get bandCount() { return this.nBands; }
  /** Number of waveform buckets this instance produces. */
  get waveCount() { return this.nWave; }

  update(audio: AudioEngine, dt = 1 / 60): AudioFrame {
    const live = this.ensureNode(audio) && audio.playing;

    if (live && this.node) {
      this.node.getByteFrequencyData(this.freqBytes);
      this.node.getByteTimeDomainData(this.timeBytes);
      for (let i = 0; i < this.freqBytes.length; i++) {
        this.frame.spectrum[i] = this.freqBytes[i] / 255;
      }
      for (let i = 0; i < FFT_SIZE; i++) {
        // Byte time-domain data is centred on 128 and spans 0..255.
        this.timeFloat[i] = (this.timeBytes[i] - 128) / 128;
      }
    } else {
      this.synthesize(audio, dt);
    }

    this.buildBandTable(audio);
    this.reduceBands(dt);
    this.reduceWaveform();
    this.summarise(audio, dt);

    return this.frame;
  }

  /**
   * Attaches an analyser to the engine's output. An AnalyserNode passes audio
   * through untouched, so tapping the engine's own analyser is safe and costs
   * nothing audible.
   */
  private ensureNode(audio: AudioEngine): boolean {
    const source = audio.analyser;
    if (!source || !audio.ctx) return false;
    if (this.node && this.nodeSource === source) return true;

    try {
      const node = audio.ctx.createAnalyser();
      node.fftSize = FFT_SIZE;
      node.smoothingTimeConstant = SMOOTHING;
      source.connect(node);
      this.node = node;
      this.nodeSource = source;
      return true;
    } catch {
      this.node = null;
      return false;
    }
  }

  /**
   * Keeps the display alive while nothing is playing. The engine already
   * synthesizes a plausible spectrum for its idle animation; this borrows that
   * envelope and shapes a matching waveform, so a silent page still breathes
   * instead of flatlining.
   */
  private synthesize(audio: AudioEngine, dt: number) {
    this.idlePhase += dt;
    const t = this.idlePhase;

    const src = audio.spectrum;
    const n = this.frame.spectrum.length;
    for (let i = 0; i < n; i++) {
      // The engine's synthetic spectrum is 512 wide; stretch it across ours.
      const v = src[Math.min(src.length - 1, Math.floor((i / n) * src.length))] ?? 0;
      this.frame.spectrum[i] = v;
    }

    const level = 0.16 + 0.5 * audio.bands.volume;
    for (let i = 0; i < FFT_SIZE; i++) {
      const u = i / FFT_SIZE;
      const wave =
        Math.sin(u * Math.PI * 12 + t * 1.9) * 0.55 +
        Math.sin(u * Math.PI * 27 - t * 1.1) * 0.28 +
        Math.sin(u * Math.PI * 61 + t * 3.3) * 0.17;
      // Taper the ends so synthesized waveforms sit calmly on the baseline.
      const window = Math.sin(u * Math.PI);
      this.timeFloat[i] = wave * level * window;
    }
  }

  /**
   * Precomputes which FFT bins feed each band. Depends on the sample rate, so
   * it is rebuilt if that ever changes. The mapping itself lives in
   * analysisMath so it can be tested without an audio device.
   */
  private buildBandTable(audio: AudioEngine) {
    const rate = audio.ctx?.sampleRate ?? 44100;
    if (rate === this.builtForRate) return;
    this.builtForRate = rate;

    const table = buildLogBands(rate, FFT_SIZE, this.nBands, this.minHz, this.maxHz);
    this.bandLo = table.lo;
    this.bandHi = table.hi;
    this.bandTilt = table.tilt;
  }

  /** Reduces FFT bins to tilted, envelope-followed band levels with peak caps. */
  private reduceBands(dt: number) {
    const { bands, bandPeaks, spectrum } = this.frame;
    const fall = PEAK_FALL_PER_SEC * dt;

    for (let i = 0; i < this.nBands; i++) {
      // Peak of the bin range, not the mean: averaging washes out a narrow
      // tone until a single loud note barely moves its bar.
      let v = 0;
      for (let b = this.bandLo[i]; b < this.bandHi[i]; b++) {
        if (spectrum[b] > v) v = spectrum[b];
      }
      v = clamp01(v * this.bandTilt[i]);

      const cur = bands[i];
      bands[i] = cur + (v - cur) * (v > cur ? BAND_ATTACK : BAND_RELEASE);

      if (bands[i] >= bandPeaks[i]) bandPeaks[i] = bands[i];
      else bandPeaks[i] = Math.max(bands[i], bandPeaks[i] - fall);
    }
  }

  /** Reduces the time-domain signal to per-bucket min, max and RMS. */
  private reduceWaveform() {
    const { waveMin, waveMax, waveRms } = this.frame;
    reduceEnvelope(this.timeFloat, this.nWave, waveMin, waveMax, waveRms);
  }

  /** Fills in the coarse band summary and transient fields. */
  private summarise(audio: AudioEngine, dt: number) {
    const f = this.frame;
    const rate = audio.ctx?.sampleRate ?? 44100;
    const hzPerBin = rate / FFT_SIZE;
    const binOf = (hz: number) =>
      Math.max(0, Math.min(Math.round(hz / hzPerBin), f.spectrum.length - 1));

    const mean = (loHz: number, hiHz: number) => {
      const lo = binOf(loHz);
      const hi = Math.max(lo + 1, binOf(hiHz));
      let sum = 0;
      for (let i = lo; i < hi; i++) sum += f.spectrum[i];
      return sum / (hi - lo);
    };

    // Exponential smoothing, frame-rate independent so the feel does not change
    // when the display drops from 60 to 30 fps.
    const a = 1 - Math.exp(-dt / 0.09);
    const s = this.smoothed;
    s.bass = s.bass + (mean(20, 80) - s.bass) * a;
    s.lowMid = s.lowMid + (mean(80, 250) - s.lowMid) * a;
    s.mid = s.mid + (mean(250, 2000) - s.mid) * a;
    s.highMid = s.highMid + (mean(2000, 6000) - s.highMid) * a;
    s.treble = s.treble + (mean(6000, 16000) - s.treble) * a;

    let sumSq = 0;
    for (let i = 0; i < this.nWave; i++) sumSq += f.waveRms[i] * f.waveRms[i];
    const rms = Math.sqrt(sumSq / this.nWave);
    s.rms = s.rms + (rms - s.rms) * a;

    if (rms > this.peak) this.peak = rms;
    else this.peak = Math.max(rms, this.peak - 0.35 * dt);

    f.bass = s.bass;
    f.lowMid = s.lowMid;
    f.mid = s.mid;
    f.highMid = s.highMid;
    f.treble = s.treble;
    f.rms = s.rms;
    f.peak = this.peak;
    f.beat = audio.beat;
    f.beatStrength = audio.beatStrength;
  }

  /** Detaches the analyser tap. Safe to call more than once. */
  dispose() {
    try { this.node?.disconnect(); } catch { /* already torn down */ }
    this.node = null;
    this.nodeSource = null;
  }
}
