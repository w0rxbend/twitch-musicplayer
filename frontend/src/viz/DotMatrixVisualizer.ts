/* DotMatrixVisualizer.ts — spectrum drawn as columns of discrete dots.
 *
 * The halftone style from the reference sheet: each frequency band is a column
 * of dots lit from the centre outward, so the display reads like an old LED
 * level meter. Dots near the top of a column are dimmer and smaller, which
 * gives the columns a soft feathered tip instead of a hard edge.
 */
import type { AudioFrame } from './types';
import { WaveScene, type WaveSceneOptions } from './WaveScene';
import { rampByName, type Ramp } from './palette';
import type * as PIXI from 'pixi.js';
import type { AudioEngine } from '../audio/AudioEngine';

const BAND_COUNT = 64;
const DOTS_PER_COLUMN = 22;

export class DotMatrixVisualizer extends WaveScene {
  private ramp: Ramp;
  private colours: number[] = [];

  constructor(app: PIXI.Application, audio: AudioEngine, options: WaveSceneOptions = {}) {
    super(app, audio, options, {
      bands: BAND_COUNT,
      wavePoints: 128,
      bloom: 1.25,
      bandHeight: 0.32,
    });
    this.ramp = rampByName(options.ramp ?? 'AURORA');
    for (let i = 0; i < BAND_COUNT; i++) {
      this.colours.push(this.ramp.hex(i / (BAND_COUNT - 1)));
    }
  }

  protected draw(frame: AudioFrame) {
    const { bands, bandPeaks } = frame;
    const g = this.gfx;

    const usable = this.W - this.marginX * 2;
    const slot = usable / BAND_COUNT;
    const amp = this.halfBand * (1 + this.beatPulse * 0.07);
    const rowGap = amp / DOTS_PER_COLUMN;
    const baseRadius = Math.min(slot * 0.30, rowGap * 0.42);

    for (let i = 0; i < BAND_COUNT; i++) {
      const x = this.marginX + i * slot + slot / 2;
      const colour = this.colours[i];
      const level = bands[i];

      // How many dots this column lights, mirrored above and below centre.
      const lit = level * DOTS_PER_COLUMN;

      for (let d = 0; d < DOTS_PER_COLUMN; d++) {
        // Partial illumination of the topmost dot gives smooth movement
        // instead of a column that jumps a whole dot at a time.
        const fill = Math.min(1, Math.max(0, lit - d));
        if (fill <= 0.02) continue;

        const dy = (d + 0.5) * rowGap;
        // Dots further from the axis shrink and dim.
        const falloff = 1 - (d / DOTS_PER_COLUMN) * 0.45;
        const r = baseRadius * falloff * (0.55 + 0.45 * fill);
        const alpha = 0.9 * fill * falloff;

        g.circle(x, this.cy - dy, r).fill({ color: colour, alpha });
        g.circle(x, this.cy + dy, r).fill({ color: colour, alpha: alpha * 0.75 });
      }

      // Peak marker: a single bright dot hanging at the recent maximum.
      const peakDy = Math.max(bandPeaks[i], level) * amp;
      if (peakDy > rowGap) {
        g.circle(x, this.cy - peakDy, baseRadius * 0.7)
          .fill({ color: 0xffffff, alpha: 0.75 });
      }

      // Always-lit dot on the axis, so a silent column still shows its place.
      g.circle(x, this.cy, baseRadius * 0.5).fill({ color: colour, alpha: 0.5 });
    }
  }
}
