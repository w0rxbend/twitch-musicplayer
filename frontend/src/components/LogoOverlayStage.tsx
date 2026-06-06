import { onCleanup, onMount } from 'solid-js';
import * as PIXI from 'pixi.js';
import { AudioEngine } from '../audio/AudioEngine';
import { LogoOverlayVisualizer } from '../viz/LogoOverlayVisualizer';

interface Props {
  onReady: (audio: AudioEngine) => void;
}

export function LogoOverlayStage(props: Props) {
  let stageRef!: HTMLDivElement;

  onMount(() => {
    const app = new PIXI.Application({
      resizeTo: stageRef,
      antialias: true,
      backgroundAlpha: 0,
      clearBeforeRender: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      powerPreference: 'high-performance',
    });
    app.ticker.maxFPS = 60;
    app.ticker.minFPS = 30;
    stageRef.appendChild(app.view as HTMLCanvasElement);

    const audio = new AudioEngine();
    const viz = new LogoOverlayVisualizer(app, audio);
    props.onReady(audio);

    let last = performance.now();
    const update = () => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      audio.update(dt, 1.05);
      viz.update(dt);
    };
    app.ticker.add(update);

    const ro = new ResizeObserver(() => viz.resize());
    ro.observe(stageRef);
    viz.resize();

    onCleanup(() => {
      ro.disconnect();
      app.ticker.remove(update);
      viz.dispose();
      audio.dispose();
      app.destroy(true, { children: true, texture: true, baseTexture: true });
    });
  });

  return <div id="logo-overlay-stage" ref={stageRef!} />;
}
