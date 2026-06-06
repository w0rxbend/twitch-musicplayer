export interface VizConfig {
  palette: string[];
  colorCycle: boolean;
  cycleSpeed: number;
  intensity: number;
  bass: number;
  bloom: number;
  density: number;
  aberration: number;
  scene: 'mountains' | 'space';
  chrome: boolean;
}

export interface AudioBands {
  bass: number;
  mids: number;
  highs: number;
  volume: number;
}
