import { createSignal, createEffect } from 'solid-js';
import { Stage } from './components/Stage';
import { Chrome } from './components/Chrome';
import { TweaksPanel } from './components/TweaksPanel';
import { Hint } from './components/Hint';
import { config } from './store/config';
import { showHint } from './store/hint';
import type { AudioEngine } from './audio/AudioEngine';
import type { Visualizer } from './viz/Visualizer';

export function App() {
  const [audio, setAudio] = createSignal<AudioEngine | null>(null);
  const [, setViz] = createSignal<Visualizer | null>(null);
  const [tweaksOpen, setTweaksOpen] = createSignal(false);

  createEffect(() => {
    document.documentElement.style.setProperty('--accent', config.palette[0]);
    document.documentElement.style.setProperty('--accent2', config.palette[1]);
  });

  const onReady = (a: AudioEngine, v: Visualizer) => {
    setAudio(a);
    setViz(v);
    showHint('use controls to load audio', 4500);
  };

  return (
    <>
      <Stage config={config} onReady={onReady} />
      <div id="vignette" />
      <div id="grain" />
      <Chrome
        audio={audio()}
        tweaksOpen={tweaksOpen()}
        onTweaksToggle={() => setTweaksOpen(o => !o)}
      />
      <Hint />
      <TweaksPanel
        open={tweaksOpen()}
        onClose={() => setTweaksOpen(false)}
      />
    </>
  );
}
