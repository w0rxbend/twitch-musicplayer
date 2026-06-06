import { createSignal, createEffect, onCleanup, onMount } from 'solid-js';
import { Stage } from './components/Stage';
import { Chrome } from './components/Chrome';
import { TweaksPanel } from './components/TweaksPanel';
import { Hint } from './components/Hint';
import { config } from './store/config';
import { showHint } from './store/hint';
import { BackendPlaybackClient } from './audio/BackendPlaybackClient';
import type { AudioEngine } from './audio/AudioEngine';
import type { Visualizer } from './viz/Visualizer';

export function App() {
  const [audio, setAudio] = createSignal<AudioEngine | null>(null);
  const [, setViz] = createSignal<Visualizer | null>(null);
  const [tweaksOpen, setTweaksOpen] = createSignal(false);
  let backendClient: BackendPlaybackClient | null = null;

  createEffect(() => {
    document.documentElement.style.setProperty('--accent', config.palette[0]);
    document.documentElement.style.setProperty('--accent2', config.palette[1]);
  });

  onMount(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 't') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      event.preventDefault();
      setTweaksOpen(open => !open);
    };

    const handlePointerDown = () => {
      backendClient?.retryPendingPlay();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', handlePointerDown);
    onCleanup(() => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', handlePointerDown);
    });
  });

  const onReady = (a: AudioEngine, v: Visualizer) => {
    setAudio(a);
    setViz(v);
    backendClient?.dispose();
    backendClient = new BackendPlaybackClient({
      audio: a,
      onStatus: msg => showHint(msg, 3200),
    });
    backendClient.start();
    showHint('press T for tweaks', 4500);
  };

  onCleanup(() => backendClient?.dispose());

  return (
    <>
      <Stage config={config} onReady={onReady} />
      <div id="vignette" />
      <div id="grain" />
      <Chrome />
      <Hint />
      <TweaksPanel
        open={tweaksOpen()}
        onClose={() => setTweaksOpen(false)}
      />
    </>
  );
}
