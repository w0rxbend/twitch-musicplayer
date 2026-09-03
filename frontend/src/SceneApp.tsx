import { createSignal, onCleanup, onMount } from 'solid-js';
import { Stage } from './components/Stage';
import { BackendPlaybackClient } from './audio/BackendPlaybackClient';
import type { AudioEngine } from './audio/AudioEngine';
import type { SceneDef } from './viz/scenes';

interface Props {
  scene: SceneDef;
  transparent?: boolean;
  /** Colour ramp name from the ?ramp= query parameter. */
  ramp?: string;
}

/**
 * One visualizer page. Every scene in the catalogue renders through this
 * component, so they all share the same playback wiring, the same "On Air"
 * chrome and the same transparent-overlay behaviour.
 *
 * The opaque variant shows a small badge and the current track. The transparent
 * variant shows the visuals alone, so it can be composited over other sources
 * in OBS without a background or any text.
 */
export function SceneApp(props: Props) {
  const [trackName, setTrackName] = createSignal('');
  const [trackArtist, setTrackArtist] = createSignal('');
  const [live, setLive] = createSignal(false);
  let backendClient: BackendPlaybackClient | null = null;

  onMount(() => {
    const root = document.documentElement;
    // Transparent pages get the overlay class only, so the page background
    // stays clear for compositing. Opaque pages get the scene's own backdrop.
    const pageClass = props.transparent
      ? 'logo-overlay-page'
      : props.scene.pageClass ?? 'scene-page';
    root.classList.add(pageClass);

    const retryPending = () => backendClient?.retryPendingPlay();
    window.addEventListener('pointerdown', retryPending);

    onCleanup(() => {
      window.removeEventListener('pointerdown', retryPending);
      root.classList.remove(pageClass);
    });
  });

  const onReady = (audio: AudioEngine) => {
    backendClient?.dispose();
    backendClient = new BackendPlaybackClient({
      audio,
      onStatus: (status) =>
        setLive(status.connection === 'connected' && status.playback === 'playing'),
      onSongChange: (song) => {
        setTrackName(song?.title ?? '');
        setTrackArtist(song?.artist ?? '');
      },
    });
    backendClient.start();
  };

  onCleanup(() => backendClient?.dispose());

  return (
    <>
      <Stage
        onReady={onReady}
        transparent={props.transparent}
        showBackground={!props.transparent}
        createVisualizer={(app, audio, opts) =>
          props.scene.create(app, audio, {
            showBackground: opts.showBackground,
            transparent: opts.transparent,
            ramp: props.ramp,
          })
        }
      />
      {!props.transparent && (
        <div id="spectrum-chrome">
          <div class="spec-badge" classList={{ 'spec-badge--live': live() }}>
            <span class="spec-dot" />
            {live() ? 'On Air' : 'Standby'}
          </div>
          <div class="spec-now" classList={{ 'spec-now--show': !!trackName() }}>
            <span class="spec-title">{trackName() || '—'}</span>
            <span class="spec-artist">{trackArtist()}</span>
          </div>
        </div>
      )}
    </>
  );
}
