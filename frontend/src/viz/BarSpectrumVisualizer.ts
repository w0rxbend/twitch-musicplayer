/* BarSpectrumVisualizer.ts — vertical bar equaliser with peak-hold caps.
 *
 * The classic block equaliser from the reference sheet: rounded columns rising
 * from a baseline, coloured across the spectrum, each with a small cap that
 * hangs at the recent maximum and then falls.
 *
 * The bars are musically spaced rather than linear, because the analysis layer
 * already delivers log-spaced bands — a linear spectrum would crowd every
 * musical detail into the leftmost tenth of the display.
 */
import type { AudioFrame } from './types';
import { WaveScene, type WaveSceneOptions } from './WaveScene';
import { rampByName, type Ramp } from './palette';
import type * as PIXI from 'pixi.js';
import type { AudioEngine } from '../audio/AudioEngine';

const BAND_COUNT = 56;
// Fraction of each slot taken by the gap between bars.
const GAP_RATIO = 0.28;
// Cap thickness in pixels, and how far above the bar it floats.
const CAP_HEIGHT = 5;
const CAP_GAP = 6;

export class BarSpectrumVisualizer extends WaveScene {
  private ramp: Ramp;
  /** Bar colours only depend on position, so they are computed once. */
  private colours: number[] = [];

  constructor(app: PIXI.Application, audio: AudioEngine, options: WaveSceneOptions = {}) {
    super(app, audio, options, {
      bands: BAND_COUNT,
      wavePoints: 128,
      bloom: 1.35,
      bandHeight: 0.34,
    });
    this.ramp = rampByName(options.ramp ?? 'SPECTRUM');
    this.cacheColours();
  }

  private cacheColours() {
    this.colours = [];
    for (let i = 0; i < BAND_COUNT; i++) {
      this.colours.push(this.ramp.hex(i / (BAND_COUNT - 1)));
    }
  }

  protected draw(frame: AudioFrame) {
    const { bands, bandPeaks } = frame;
    const g = this.gfx;

    const usable = this.W - this.marginX * 2;
    const slot = usable / BAND_COUNT;
    const barW = slot * (1 - GAP_RATIO);
    const radius = Math.min(barW / 2, 6);

    // Bars grow upward from a baseline sitting below centre, leaving the lower
    // third for the reflection.
    const baseline = this.cy + this.halfBand * 0.55;
    const maxH = this.halfBand * 1.5 * (1 + this.beatPulse * 0.06);

    for (let i = 0; i < BAND_COUNT; i++) {
      const x = this.marginX + i * slot + (slot - barW) / 2;
      const colour = this.colours[i];

      // A floor keeps every bar visible when the track is quiet, so the
      // equaliser reads as an instrument rather than an empty display.
      const level = Math.max(0.012, bands[i]);
      const h = level * maxH;
      const y = baseline - h;

      g.roundRect(x, y, barW, h, radius).fill({ color: colour, alpha: 0.95 });

      // Mirrored reflection below the baseline, fading out.
      g.roundRect(x, baseline + 2, barW, h * 0.34, radius)
        .fill({ color: colour, alpha: 0.16 });

      // Peak-hold cap.
      const peakH = Math.max(bandPeaks[i], level) * maxH;
      const capY = baseline - peakH - CAP_GAP;
      if (peakH > h + CAP_GAP * 0.5) {
        g.roundRect(x, capY, barW, CAP_HEIGHT, CAP_HEIGHT / 2)
          .fill({ color: colour, alpha: 0.9 });
      }
    }

    // A thin baseline ties the columns together.
    g.moveTo(this.marginX, baseline + 1)
      .lineTo(this.W - this.marginX, baseline + 1)
      .stroke({ color: 0xffffff, alpha: 0.10, width: 1 });
  }

  protected onResize() {
    this.cacheColours();
  }
}
