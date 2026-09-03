import { createSignal, onCleanup, onMount } from 'solid-js';
import { Stage } from './components/Stage';
import { OscilloscopeVisualizer } from './viz/OscilloscopeVisualizer';
import { BackendPlaybackClient } from './audio/BackendPlaybackClient';
import type { AudioEngine } from './audio/AudioEngine';

interface Props {
  transparent?: boolean;
}

/**
 * SpectrumApp — dedicated audio-spectrum page rendering the glowing
 * oscilloscope waveform. Reachable at /spectrum (and /spectrum?transparent=1
 * for a chroma-free stream overlay).
 */
export function SpectrumApp(props: Props = {}) {
  const [trackName, setTrackName] = createSignal('');
  const [trackArtist, setTrackArtist] = createSignal('');
  const [live, setLive] = createSignal(false);
  let backendClient: BackendPlaybackClient | null = null;

  onMount(() => {
    // Transparent (OBS) mode: only the overlay class, so the page background
    // stays fully transparent. Opaque mode: the dark spectrum background.
    if (props.transparent) document.documentElement.classList.add('logo-overlay-page');
    else document.documentElement.classList.add('spectrum-page');
    const retryPending = () => backendClient?.retryPendingPlay();
    window.addEventListener('pointerdown', retryPending);
    onCleanup(() => {
      window.removeEventListener('pointerdown', retryPending);
      document.documentElement.classList.remove('spectrum-page');
      document.documentElement.classList.remove('logo-overlay-page');
    });
  });

  const onReady = (audio: AudioEngine) => {
    backendClient?.dispose();
    backendClient = new BackendPlaybackClient({
      audio,
      // "On Air" means both halves are healthy: the socket is up and audio is
      // actually playing. The previous substring match also lit up for
      // "radio connection error", because that string contains "connect".
      onStatus: (status) => setLive(status.connection === 'connected' && status.playback === 'playing'),
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
          new OscilloscopeVisualizer(app, audio, {
            showBackground: opts.showBackground,
            transparent: opts.transparent,
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
