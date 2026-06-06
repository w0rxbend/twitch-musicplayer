import type { AudioEngine } from './AudioEngine';
import type { AudioFrame } from '../viz/types';

const FFT_SIZE = 1024; // AudioEngine uses fftSize 1024 → 512 freq bins

function bandAvg(sp: Float32Array, lo: number, hi: number): number {
  const count = hi - lo;
  if (count <= 0) return 0;
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += sp[i];
  return sum / count;
}

function freqBin(hz: number, sampleRate: number): number {
  return Math.min(Math.round(hz / (sampleRate / FFT_SIZE)), 511);
}

export class AudioAnalysisEngine {
  private s = { bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, rms: 0 };
  private peak = 0;
  private readonly α = 0.72;

  // time-domain buffers
  private tdRaw = new Uint8Array(1024);
  private tdFloat = new Float32Array(1024);

  private _frame: AudioFrame = {
    bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0,
    rms: 0, peak: 0, beat: false, beatStrength: 0,
    spectrum: new Float32Array(512),
    timeDomain: new Float32Array(1024),
  };

  update(audio: AudioEngine): AudioFrame {
    const sp = audio.spectrum;
    const sr = audio.ctx?.sampleRate ?? 44100;

    const b0 = freqBin(20, sr),  b1 = freqBin(80, sr);
    const b2 = freqBin(250, sr), b3 = freqBin(2000, sr);
    const b4 = freqBin(6000, sr), b5 = Math.min(freqBin(20000, sr), 511);

    const α = this.α;
    this.s.bass   = α * this.s.bass   + (1 - α) * bandAvg(sp, b0, b1);
    this.s.lowMid = α * this.s.lowMid + (1 - α) * bandAvg(sp, b1, b2);
    this.s.mid    = α * this.s.mid    + (1 - α) * bandAvg(sp, b2, b3);
    this.s.highMid= α * this.s.highMid+ (1 - α) * bandAvg(sp, b3, b4);
    this.s.treble = α * this.s.treble + (1 - α) * bandAvg(sp, b4, b5);

    let sumSq = 0;
    for (let i = 0; i < sp.length; i++) sumSq += sp[i] * sp[i];
    const rawRms = Math.sqrt(sumSq / sp.length);
    this.s.rms = α * this.s.rms + (1 - α) * rawRms;

    if (rawRms > this.peak) this.peak = rawRms;
    else this.peak *= 0.997;

    // Time-domain waveform from analyser (when available)
    if (audio.analyser && audio.ctx) {
      audio.analyser.getByteTimeDomainData(this.tdRaw);
      for (let i = 0; i < 1024; i++) {
        this.tdFloat[i] = (this.tdRaw[i] - 128) / 128;
      }
    } else {
      this.tdFloat.fill(0);
    }

    this._frame.bass         = this.s.bass;
    this._frame.lowMid       = this.s.lowMid;
    this._frame.mid          = this.s.mid;
    this._frame.highMid      = this.s.highMid;
    this._frame.treble       = this.s.treble;
    this._frame.rms          = this.s.rms;
    this._frame.peak         = this.peak;
    this._frame.beat         = audio.beat;
    this._frame.beatStrength = audio.beatStrength;
    this._frame.spectrum     = sp;
    this._frame.timeDomain   = this.tdFloat;

    return this._frame;
  }
}
