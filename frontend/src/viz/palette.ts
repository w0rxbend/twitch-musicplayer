/* palette.ts — colour ramps shared by the waveform and spectrum scenes.
 *
 * The reference artwork is built almost entirely from smooth multi-stop
 * gradients running along the display. Keeping the ramps here means every
 * scene draws from the same set, so a page can be recoloured by swapping one
 * name rather than editing drawing code.
 */

export type RGB = [number, number, number];

interface Stop { at: number; rgb: RGB }

export class Ramp {
  private readonly stops: Stop[];

  constructor(stops: Stop[]) {
    // Sorted once so sampling can assume ascending order.
    this.stops = [...stops].sort((a, b) => a.at - b.at);
  }

  /** Colour at position t (0..1), linearly interpolated between stops. */
  sample(t: number): RGB {
    const s = this.stops;
    const x = t < 0 ? 0 : t > 1 ? 1 : t;

    if (x <= s[0].at) return s[0].rgb;
    if (x >= s[s.length - 1].at) return s[s.length - 1].rgb;

    for (let i = 0; i < s.length - 1; i++) {
      const a = s[i];
      const b = s[i + 1];
      if (x >= a.at && x <= b.at) {
        const span = b.at - a.at || 1;
        const u = (x - a.at) / span;
        return [
          a.rgb[0] + (b.rgb[0] - a.rgb[0]) * u,
          a.rgb[1] + (b.rgb[1] - a.rgb[1]) * u,
          a.rgb[2] + (b.rgb[2] - a.rgb[2]) * u,
        ];
      }
    }
    return s[s.length - 1].rgb;
  }

  /** Colour at t packed as 0xRRGGBB, which is what Pixi wants. */
  hex(t: number): number {
    const [r, g, b] = this.sample(t);
    return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  }

  /** Colour at t as a CSS string, for gradient stops. */
  css(t: number, alpha = 1): string {
    const [r, g, b] = this.sample(t);
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
  }

  /** Evenly spaced CSS stops, for building a Pixi FillGradient. */
  cssStops(count = 8, alpha = 1): { offset: number; color: string }[] {
    const out: { offset: number; color: string }[] = [];
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : i / (count - 1);
      out.push({ offset: t, color: this.css(t, alpha) });
    }
    return out;
  }
}

const rgb = (r: number, g: number, b: number): RGB => [r, g, b];

/** Full spectrum sweep — the signature look of the reference sheet. */
export const SPECTRUM = new Ramp([
  { at: 0.00, rgb: rgb(255, 61, 129) },   // hot pink
  { at: 0.18, rgb: rgb(168, 85, 247) },   // violet
  { at: 0.36, rgb: rgb(59, 130, 246) },   // blue
  { at: 0.52, rgb: rgb(34, 211, 238) },   // cyan
  { at: 0.68, rgb: rgb(52, 211, 153) },   // green
  { at: 0.84, rgb: rgb(250, 204, 21) },   // yellow
  { at: 1.00, rgb: rgb(249, 115, 22) },   // orange
]);

/** Cool to warm, the classic "audio wave" gradient. */
export const AURORA = new Ramp([
  { at: 0.00, rgb: rgb(34, 211, 238) },
  { at: 0.35, rgb: rgb(52, 211, 153) },
  { at: 0.70, rgb: rgb(250, 204, 21) },
  { at: 1.00, rgb: rgb(251, 113, 133) },
]);

/** Sunset — amber through to deep magenta. */
export const EMBER = new Ramp([
  { at: 0.00, rgb: rgb(253, 224, 71) },
  { at: 0.30, rgb: rgb(251, 146, 60) },
  { at: 0.62, rgb: rgb(244, 63, 94) },
  { at: 1.00, rgb: rgb(190, 24, 93) },
]);

/** Cyan through violet — cold neon. */
export const NEON = new Ramp([
  { at: 0.00, rgb: rgb(34, 211, 238) },
  { at: 0.45, rgb: rgb(99, 102, 241) },
  { at: 1.00, rgb: rgb(232, 121, 249) },
]);

/** Level-meter colouring: green until it gets loud, then amber, then red. */
export const VU = new Ramp([
  { at: 0.00, rgb: rgb(34, 197, 94) },
  { at: 0.55, rgb: rgb(163, 230, 53) },
  { at: 0.78, rgb: rgb(250, 204, 21) },
  { at: 0.92, rgb: rgb(249, 115, 22) },
  { at: 1.00, rgb: rgb(239, 68, 68) },
]);

export const RAMPS = { SPECTRUM, AURORA, EMBER, NEON, VU } as const;
export type RampName = keyof typeof RAMPS;

/** Looks up a ramp by name, falling back to the spectrum sweep. */
export function rampByName(name: string | undefined): Ramp {
  if (!name) return SPECTRUM;
  const key = name.toUpperCase() as RampName;
  return RAMPS[key] ?? SPECTRUM;
}
