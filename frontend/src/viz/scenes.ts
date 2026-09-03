/* scenes.ts — the catalogue of visualizer pages.
 *
 * One entry per scene. Adding a visualizer means adding a row here: the router,
 * the scene index page and the documentation all read from this list, so there
 * is no separate place to forget to update.
 */
import type * as PIXI from 'pixi.js';
import type { AudioEngine } from '../audio/AudioEngine';
import type { Visualizer } from './types';

import { OscilloscopeVisualizer } from './OscilloscopeVisualizer';
import { BarSpectrumVisualizer } from './BarSpectrumVisualizer';
import { MirrorWaveVisualizer } from './MirrorWaveVisualizer';
import { DotMatrixVisualizer } from './DotMatrixVisualizer';
import { RibbonVisualizer } from './RibbonVisualizer';
import { LineWaveVisualizer } from './LineWaveVisualizer';
import { LensWaveVisualizer } from './LensWaveVisualizer';

export interface SceneBuildOptions {
  showBackground: boolean;
  transparent: boolean;
  /** Colour ramp name from palette.ts, usually taken from the ?ramp= query. */
  ramp?: string;
}

export interface SceneDef {
  /** URL segment: /<slug> for the opaque page, /<slug>-overlay for transparent. */
  slug: string;
  /** Short name shown on the scene index. */
  label: string;
  /** One line describing the look, for the index page and the docs. */
  description: string;
  /** Emoji used on the index card. */
  icon: string;
  /** Class added to <html> for the opaque variant, to set the page background. */
  pageClass?: string;
  create(app: PIXI.Application, audio: AudioEngine, options: SceneBuildOptions): Visualizer;
}

export const SCENES: SceneDef[] = [
  {
    slug: 'spectrum',
    label: 'Oscilloscope',
    description: 'Single glowing trace with a cyan and magenta chromatic split.',
    icon: '〰️',
    pageClass: 'spectrum-page',
    create: (app, audio, o) =>
      new OscilloscopeVisualizer(app, audio, {
        showBackground: o.showBackground,
        transparent: o.transparent,
      }),
  },
  {
    slug: 'bars',
    label: 'Equaliser',
    description: 'Rounded columns with peak-hold caps and a mirrored reflection.',
    icon: '📊',
    pageClass: 'scene-page',
    create: (app, audio, o) => new BarSpectrumVisualizer(app, audio, o),
  },
  {
    slug: 'mirror',
    label: 'Mirror Wave',
    description: 'Dense mirrored bars — the classic audio-editor waveform.',
    icon: '🌊',
    pageClass: 'scene-page',
    create: (app, audio, o) => new MirrorWaveVisualizer(app, audio, o),
  },
  {
    slug: 'dots',
    label: 'Dot Matrix',
    description: 'Halftone columns of dots, lit outward from the centre axis.',
    icon: '⣿',
    pageClass: 'scene-page',
    create: (app, audio, o) => new DotMatrixVisualizer(app, audio, o),
  },
  {
    slug: 'ribbon',
    label: 'Ribbon',
    description: 'Smooth gradient-filled blob that flows rather than flickers.',
    icon: '🎗️',
    pageClass: 'scene-page',
    create: (app, audio, o) => new RibbonVisualizer(app, audio, o),
  },
  {
    slug: 'line',
    label: 'Trace',
    description: 'Sharp unsmoothed polyline with a colour sweep along its length.',
    icon: '📈',
    pageClass: 'scene-page',
    create: (app, audio, o) => new LineWaveVisualizer(app, audio, o),
  },
  {
    slug: 'lens',
    label: 'Facets',
    description: 'Overlapping mirrored diamonds, coloured like a level meter.',
    icon: '💠',
    pageClass: 'scene-page',
    create: (app, audio, o) => new LensWaveVisualizer(app, audio, o),
  },
];

export interface SceneRoute {
  scene: SceneDef;
  transparent: boolean;
}

/**
 * Matches a pathname to a scene. `/bars` is the opaque page and `/bars-overlay`
 * the transparent one; `?transparent=1` forces transparency on either.
 */
export function matchScene(pathname: string, search: string): SceneRoute | null {
  const slug = pathname.replace(/^\/+|\/+$/g, '');
  const forced = new URLSearchParams(search).get('transparent') === '1';

  for (const scene of SCENES) {
    if (slug === scene.slug) return { scene, transparent: forced };
    if (slug === `${scene.slug}-overlay`) return { scene, transparent: true };
  }
  return null;
}
