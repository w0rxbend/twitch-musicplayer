import { onMount, onCleanup } from 'solid-js';
import * as PIXI from 'pixi.js';
import { AudioEngine } from '../audio/AudioEngine';
import { shouldAutoStartAudio } from '../audio/autoplay';
import { LofiRainVisualizer } from '../viz/LofiRainVisualizer';

interface Props {
  onReady: (audio: AudioEngine) => void;
  transparent?: boolean;
  showBackground?: boolean;
}

export function Stage(props: Props) {
  let stageRef!: HTMLDivElement;

  onMount(() => {
    const app = new PIXI.Application();
    let initialized = false;
    let disposed = false;
    let audio: AudioEngine | null = null;
    let viz: LofiRainVisualizer | null = null;
    let ro: ResizeObserver | null = null;
    let tickerUpdate: (() => void) | null = null;

    onCleanup(() => {
      disposed = true;
      ro?.disconnect();
      if (tickerUpdate && initialized) app.ticker.remove(tickerUpdate);
      viz?.dispose();
      audio?.dispose();
      if (initialized) {
        app.destroy(
          { removeView: true, releaseGlobalResources: true },
          { children: true, texture: true, textureSource: true },
        );
      }
    });

    void (async () => {
      await app.init({
        resizeTo: stageRef,
        antialias: true,
        backgroundAlpha: props.transparent ? 0 : 1,
        background: props.transparent ? 0x000000 : 0x04070f,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
        powerPreference: 'high-performance',
      });
      initialized = true;

      if (disposed) {
        app.destroy({ removeView: true }, { children: true });
        return;
      }

      app.ticker.maxFPS = 60;
      app.ticker.minFPS = 30;
      stageRef.appendChild(app.canvas);

      audio = new AudioEngine({ allowAutoplay: shouldAutoStartAudio(false) });
      viz = new LofiRainVisualizer(app, audio, {
        showBackground: props.showBackground ?? true,
      });

      props.onReady(audio);

      let last = performance.now();
      tickerUpdate = () => {
        if (!audio || !viz) return;
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        audio.update(dt, 1);
        viz.update(dt);
      };
      app.ticker.add(tickerUpdate);

      ro = new ResizeObserver(() => viz?.resize());
      ro.observe(stageRef);
    })().catch(err => console.error('Stage init failed', err));
  });

  return <div id="stage" ref={stageRef!} />;
}
