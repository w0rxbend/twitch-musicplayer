/* analysisMath.ts — the two reductions that turn analyser output into
 * something worth drawing. Kept as pure functions so they can be tested
 * without a browser or an audio device.
 */

export interface LogBandTable {
  /** First FFT bin of each band, inclusive. */
  lo: Int32Array;
  /** Last FFT bin of each band, exclusive. */
  hi: Int32Array;
  /** Per-band gain correcting music's natural roll-off at high frequencies. */
  tilt: Float32Array;
}

/**
 * Maps FFT bins onto bands spaced by octave.
 *
 * FFT bins are linear in frequency: with a 2048-point transform at 44.1 kHz,
 * bin 0 covers 0–21 Hz and bin 1023 covers 21.5–21.6 kHz. Drawing one bar per
 * bin puts every musically interesting frequency in the leftmost sliver of the
 * display and wastes the other 90% on inaudible detail. Spacing the bands
 * logarithmically gives each octave the same width, which is how the ear hears.
 *
 * Bands are widened to at least one bin. At the bottom of the range an octave
 * is narrower than a single bin, so several bands would otherwise share a bin
 * and move in lockstep.
 */
export function buildLogBands(
  sampleRate: number,
  fftSize: number,
  nBands: number,
  minHz: number,
  maxHz: number,
): LogBandTable {
  const binCount = Math.floor(fftSize / 2);
  const hzPerBin = sampleRate / fftSize;
  const ratio = maxHz / minHz;

  const lo = new Int32Array(nBands);
  const hi = new Int32Array(nBands);
  const tilt = new Float32Array(nBands);

  for (let i = 0; i < nBands; i++) {
    const loHz = minHz * Math.pow(ratio, i / nBands);
    const hiHz = minHz * Math.pow(ratio, (i + 1) / nBands);

    const l = Math.max(0, Math.min(Math.floor(loHz / hzPerBin), binCount - 1));
    const h = Math.max(l + 1, Math.min(Math.ceil(hiHz / hzPerBin), binCount));

    lo[i] = l;
    hi[i] = h;
    // Roughly +4.5 dB per octave across the range.
    tilt[i] = 1 + 1.35 * (i / nBands);
  }

  return { lo, hi, tilt };
}

/**
 * Reduces a time-domain signal to per-bucket minimum, maximum and RMS.
 *
 * This is the difference between a waveform that looks solid and one that
 * flickers. Taking every Nth sample instead lands at an arbitrary point in each
 * oscillation, so a steady loud tone renders as a thin wandering line whose
 * height depends on nothing but luck. Taking the extremes of each bucket
 * reproduces the envelope, which is what an audio editor draws.
 *
 * Output arrays are written in place and must each hold `buckets` entries.
 */
export function reduceEnvelope(
  samples: Float32Array,
  buckets: number,
  outMin: Float32Array,
  outMax: Float32Array,
  outRms: Float32Array,
): void {
  const n = samples.length;
  if (buckets <= 0) return;

  const perBucket = n / buckets;

  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * perBucket);
    const end = Math.min(n, Math.floor((i + 1) * perBucket));

    if (end <= start) {
      outMin[i] = 0;
      outMax[i] = 0;
      outRms[i] = 0;
      continue;
    }

    let lo = Infinity;
    let hi = -Infinity;
    let sumSq = 0;
    for (let s = start; s < end; s++) {
      const v = samples[s];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sumSq += v * v;
    }

    outMin[i] = lo;
    outMax[i] = hi;
    outRms[i] = Math.sqrt(sumSq / (end - start));
  }
}
