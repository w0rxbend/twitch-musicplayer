import { onMount, onCleanup } from 'solid-js';
import * as PIXI from 'pixi.js';
import { AudioEngine } from '../audio/AudioEngine';
import { Visualizer } from '../viz/Visualizer';
import { VIZ2_RAMP } from '../viz/config';
import type { VizConfig } from '../viz/types';

interface Props {
  config: VizConfig;
  onReady: (audio: AudioEngine, viz: Visualizer) => void;
}

export function Stage(props: Props) {
  let stageRef!: HTMLDivElement;

  onMount(() => {
    const app = new PIXI.Application({
      resizeTo: stageRef,
      antialias: false,
      backgroundAlpha: 1,
      backgroundColor: 0x04050d,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      powerPreference: 'high-performance',
    });
    stageRef.appendChild(app.view as HTMLCanvasElement);

    const audio = new AudioEngine();
    const viz = new Visualizer(app, audio, VIZ2_RAMP);
    viz.applyConfig(props.config, true);
    viz.resize();
    props.onReady(audio, viz);

    let last = performance.now();
    app.ticker.add(() => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      audio.update(dt, props.config.intensity);
      viz.applyConfig(props.config);
      viz.update(dt, props.config);
    });

    const ro = new ResizeObserver(() => viz.resize());
    ro.observe(stageRef);

    onCleanup(() => {
      ro.disconnect();
      app.destroy(true, { children: true, texture: true, baseTexture: true });
    });
  });

  return <div id="stage" ref={stageRef!} />;
}
