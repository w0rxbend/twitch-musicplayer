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

// Kept for AudioEngine backward compatibility
export interface AudioBands {
  bass: number;
  mids: number;
  highs: number;
  volume: number;
}
