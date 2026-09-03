/* MirrorWaveVisualizer.ts — dense mirrored waveform, the "audio editor" look.
 *
 * Hundreds of thin vertical lines mirrored about a centre axis, each as tall as
 * the signal was loud at that moment. This is the style in the reference sheet
 * that looks like a spiky ribbon thickest in the middle of a phrase.
 *
 * It depends entirely on the analysis layer reducing the time-domain signal to
 * per-bucket min and max. Point-sampling every Nth sample instead would produce
 * a thin flickering mess, because each sample lands at an arbitrary point in
 * the oscillation rather than at its extreme.
 */
import type { AudioFrame } from './types';
import { WaveScene, type WaveSceneOptions } from './WaveScene';
import { rampByName, type Ramp } from './palette';
import type * as PIXI from 'pixi.js';
import type { AudioEngine } from '../audio/AudioEngine';

const WAVE_POINTS = 320;
// Lines thinner than this disappear once the bloom filter spreads them.
const MIN_LINE_WIDTH = 1.4;

export class MirrorWaveVisualizer extends WaveScene {
  private ramp: Ramp;
  private colours: number[] = [];
  /** Smoothed magnitude per bucket, so the shape breathes instead of buzzing. */
  private smooth = new Float32Array(WAVE_POINTS);

  constructor(app: PIXI.Application, audio: AudioEngine, options: WaveSceneOptions = {}) {
    super(app, audio, options, {
      wavePoints: WAVE_POINTS,
      bands: 48,
      bloom: 1.5,
      bandHeight: 0.30,
    });
    this.ramp = rampByName(options.ramp ?? 'EMBER');
    for (let i = 0; i < WAVE_POINTS; i++) {
      this.colours.push(this.ramp.hex(i / (WAVE_POINTS - 1)));
    }
  }

  protected draw(frame: AudioFrame, dt: number) {
    const { waveMin, waveMax } = frame;
    const g = this.gfx;

    const usable = this.W - this.marginX * 2;
    const step = usable / WAVE_POINTS;
    const lineW = Math.max(MIN_LINE_WIDTH, step * 0.62);
    const amp = this.halfBand * (1 + this.beatPulse * 0.08);

    // Snap up, ease down: a transient should read instantly, but the decay
    // should not strobe.
    const attack = 1 - Math.exp(-dt / 0.012);
    const release = 1 - Math.exp(-dt / 0.13);

    for (let i = 0; i < WAVE_POINTS; i++) {
      // Peak-to-peak excursion in this bucket is the honest height of the
      // waveform there.
      const target = Math.min(1, Math.max(Math.abs(waveMin[i]), Math.abs(waveMax[i])));
      const cur = this.smooth[i];
      this.smooth[i] = cur + (target - cur) * (target > cur ? attack : release);

      // Taper towards the edges so the ribbon starts and ends calmly rather
      // than being chopped off at the margins.
      const t = i / (WAVE_POINTS - 1);
      const window = Math.pow(Math.sin(Math.PI * t), 0.55);

      const h = Math.max(1.5, this.smooth[i] * window * amp);
      const x = this.marginX + i * step + step / 2;

      g.roundRect(x - lineW / 2, this.cy - h, lineW, h * 2, lineW / 2)
        .fill({ color: this.colours[i], alpha: 0.92 });
    }

    // Bright centre axis, the seam the reflection hinges on.
    g.moveTo(this.marginX, this.cy)
      .lineTo(this.W - this.marginX, this.cy)
      .stroke({ color: 0xffffff, alpha: 0.5, width: 1.5 });
  }
}
