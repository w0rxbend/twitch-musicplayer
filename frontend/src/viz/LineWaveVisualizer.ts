/* LineWaveVisualizer.ts — sharp polyline oscilloscope with a colour sweep.
 *
 * The angular style from the reference sheet: a single unsmoothed polyline
 * whose colour changes along its length. Unlike the ribbon scene, nothing here
 * is rounded — the sharp corners are the point, so this reads as a raw signal
 * trace rather than a designed shape.
 *
 * Drawn as many short segments rather than one path, because a single Pixi
 * stroke can only carry one colour and the sweep is what makes the style.
 */
import type { AudioFrame } from './types';
import { WaveScene, type WaveSceneOptions } from './WaveScene';
import { rampByName, type Ramp } from './palette';
import type * as PIXI from 'pixi.js';
import type { AudioEngine } from '../audio/AudioEngine';

const POINTS = 200;

export class LineWaveVisualizer extends WaveScene {
  private ramp: Ramp;
  private smooth = new Float32Array(POINTS);
  /**
   * Auto-gain. A quiet passage would otherwise draw a nearly flat line, which
   * reads as "broken" rather than "quiet". Normalising against the recent peak
   * keeps the trace filling the band whatever the track's level is.
   */
  private gain = 1;

  constructor(app: PIXI.Application, audio: AudioEngine, options: WaveSceneOptions = {}) {
    super(app, audio, options, {
      wavePoints: POINTS,
      bands: 40,
      bloom: 1.45,
      bandHeight: 0.30,
    });
    this.ramp = rampByName(options.ramp ?? 'SPECTRUM');
  }

  protected draw(frame: AudioFrame, dt: number) {
    const g = this.gfx;
    const usable = this.W - this.marginX * 2;
    const step = usable / (POINTS - 1);
    const amp = this.halfBand * (1 + this.beatPulse * 0.12);

    // Light time smoothing only: too much and the corners round themselves off.
    const a = 1 - Math.exp(-dt / 0.035);

    // Largest excursion in this frame drives the auto-gain.
    let excursion = 0;
    for (let i = 0; i < POINTS; i++) {
      const e = Math.max(Math.abs(frame.waveMax[i]), Math.abs(frame.waveMin[i]));
      if (e > excursion) excursion = e;
    }
    const targetGain = Math.min(4, Math.max(1, 0.85 / Math.max(0.08, excursion)));
    // Ride the gain slowly, so a loud transient does not visibly squash the
    // trace and a quiet moment does not pump it.
    this.gain += (targetGain - this.gain) * (1 - Math.exp(-dt / 0.5));

    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < POINTS; i++) {
      // Alternating min/max picks out the extremes of each bucket, which is
      // what gives this style its zigzag rather than a soft curve.
      const raw = i % 2 === 0 ? frame.waveMax[i] : frame.waveMin[i];
      this.smooth[i] += (raw - this.smooth[i]) * a;

      const t = i / (POINTS - 1);
      const window = Math.pow(Math.sin(Math.PI * t), 0.5);
      xs.push(this.marginX + i * step);
      const v = Math.max(-1, Math.min(1, this.smooth[i] * this.gain));
      ys.push(this.cy - v * window * amp);
    }

    // Wide dim pass first to feed the bloom, then the crisp line on top.
    for (const pass of [{ w: 7, a: 0.16 }, { w: 2.4, a: 1 }]) {
      for (let i = 0; i < POINTS - 1; i++) {
        const t = i / (POINTS - 2);
        g.moveTo(xs[i], ys[i])
          .lineTo(xs[i + 1], ys[i + 1])
          .stroke({
            color: this.ramp.hex(t),
            alpha: pass.a,
            width: pass.w,
            cap: 'round',
            join: 'round',
          });
      }
    }
  }
}
