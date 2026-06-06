import type { VizConfig } from './types';

export const VIZ2_RAMP: string[] = [
  '#22d3ee', '#3b82f6', '#7c5cff', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#fb7185', '#fb923c', '#fbbf24',
  '#a3e635', '#34d399',
];

export const VIZ2_PALETTES: Record<string, string[]> = {
  Nebula:  ['#22d3ee', '#d946ef', '#0a0e27', '#04050d', '#7c5cff'],
  Cyber:   ['#22d3ee', '#a855f7', '#0a1030', '#03040f', '#3b82f6'],
  Bloom:   ['#f472b6', '#a78bfa', '#190b2e', '#080412', '#ec4899'],
  Forest:  ['#34d399', '#22d3ee', '#04130f', '#010907', '#a3e635'],
  Sunset:  ['#fb923c', '#f43f5e', '#1c0a05', '#0b0301', '#fbbf24'],
};

export const TWEAK_DEFAULTS: VizConfig = {
  palette: ['#22d3ee', '#d946ef', '#0a0e27', '#04050d', '#7c5cff'],
  colorCycle: true,
  cycleSpeed: 1,
  intensity: 1.15,
  bass: 1.15,
  bloom: 0.85,
  density: 0.8,
  aberration: 0.65,
  scene: 'mountains',
  chrome: true,
};
