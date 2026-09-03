/* LensWaveVisualizer.ts — mirrored lens and diamond segments.
 *
 * The style from the reference sheet built out of pointed leaf shapes: each
 * frequency band becomes a diamond centred on the axis, tall where the band is
 * loud. Neighbouring diamonds overlap slightly so a busy passage reads as one
 * continuous jagged body rather than separate pieces.
 */
import type { AudioFrame } from './types';
import { WaveScene, type WaveSceneOptions } from './WaveScene';
import { rampByName, type Ramp } from './palette';
import type * as PIXI from 'pixi.js';
import type { AudioEngine } from '../audio/AudioEngine';

const SEGMENTS = 44;

export class LensWaveVisualizer extends WaveScene {
  private ramp: Ramp;
  private colours: number[] = [];
  private smooth = new Float32Array(SEGMENTS);

  constructor(app: PIXI.Application, audio: AudioEngine, options: WaveSceneOptions = {}) {
    super(app, audio, options, {
      bands: SEGMENTS,
      wavePoints: SEGMENTS,
      bloom: 1.4,
      bandHeight: 0.30,
    });
    this.ramp = rampByName(options.ramp ?? 'VU');
    for (let i = 0; i < SEGMENTS; i++) {
      this.colours.push(this.ramp.hex(i / (SEGMENTS - 1)));
    }
  }

  protected draw(frame: AudioFrame, dt: number) {
    const g = this.gfx;
    const usable = this.W - this.marginX * 2;
    const slot = usable / SEGMENTS;
    const amp = this.halfBand * (1 + this.beatPulse * 0.09);

    const attack = 1 - Math.exp(-dt / 0.02);
    const release = 1 - Math.exp(-dt / 0.16);

    for (let i = 0; i < SEGMENTS; i++) {
      // Loudness of the band, combined with the local waveform excursion so
      // the shape responds to transients as well as to tone.
      const target = Math.min(1, frame.bands[i] * 0.75 + frame.waveRms[i] * 1.4);
      const cur = this.smooth[i];
      this.smooth[i] = cur + (target - cur) * (target > cur ? attack : release);

      const t = i / (SEGMENTS - 1);
      const window = Math.pow(Math.sin(Math.PI * t), 0.4);
      const h = Math.max(2, this.smooth[i] * window * amp);

      // Widened past its slot so neighbours overlap into a continuous body.
      const halfW = slot * 0.72;
      const x = this.marginX + i * slot + slot / 2;
      const colour = this.colours[i];

      // Diamond: left point, top, right point, bottom.
      g.moveTo(x - halfW, this.cy)
        .lineTo(x, this.cy - h)
        .lineTo(x + halfW, this.cy)
        .lineTo(x, this.cy + h)
        .closePath()
        .fill({ color: colour, alpha: 0.5 });

      // Outline, brighter than the fill so the facets stay legible when they
      // overlap.
      g.moveTo(x - halfW, this.cy)
        .lineTo(x, this.cy - h)
        .lineTo(x + halfW, this.cy)
        .lineTo(x, this.cy + h)
        .closePath()
        .stroke({ color: colour, alpha: 0.95, width: 1.4, join: 'round' });
    }

    g.moveTo(this.marginX, this.cy)
      .lineTo(this.W - this.marginX, this.cy)
      .stroke({ color: 0xffffff, alpha: 0.22, width: 1 });
  }
}
