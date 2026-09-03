export interface AudioFrame {
  bass: number;
  lowMid: number;
  mid: number;
  highMid: number;
  treble: number;
  rms: number;
  peak: number;
  beat: boolean;
  beatStrength: number;

  /** Raw linear FFT magnitudes, 0..1. Mostly useful for texture, not for bars. */
  spectrum: Float32Array;
  /** Raw time-domain samples, -1..1, at the analyser's full resolution. */
  timeDomain: Float32Array;

  // ── Display-ready series ──────────────────────────────────────────────────
  // Derived once per frame by AudioAnalysisEngine so every visualizer draws
  // from the same well-conditioned data instead of re-deriving it badly.

  /**
   * Log-spaced frequency bands, 0..1, one per bar of a spectrum display.
   * Musically spaced rather than linear, so octaves get equal screen width,
   * and tilted to compensate for the natural energy roll-off at high
   * frequencies. Fast attack, slow release.
   */
  bands: Float32Array;
  /** Slowly falling peak-hold value per band, for the classic meter caps. */
  bandPeaks: Float32Array;

  /**
   * Per-bucket minimum and maximum of the time-domain signal, -1..1.
   * This is how an audio editor draws a waveform: taking every Nth sample
   * instead would alias badly and turn a loud passage into a thin flickering
   * line. Use these for filled or mirrored waveform shapes.
   */
  waveMin: Float32Array;
  waveMax: Float32Array;
  /** Per-bucket RMS magnitude, 0..1. A smooth envelope of the waveform above. */
  waveRms: Float32Array;
}

// Common interface for a full-stage visualizer driven by the Stage ticker.
export interface Visualizer {
  update(dt: number): void;
  resize(): void;
  dispose(): void;
}

// Kept for AudioEngine backward compatibility
export interface AudioBands {
  bass: number;
  mids: number;
  highs: number;
  volume: number;
}
