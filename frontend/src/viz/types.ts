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
  spectrum: Float32Array;
  timeDomain: Float32Array;  // normalised -1..1, 1024 samples
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
