import { onCleanup, onMount } from 'solid-js';
import { Stage } from './components/Stage';
import { BackendPlaybackClient } from './audio/BackendPlaybackClient';
import type { AudioEngine } from './audio/AudioEngine';

interface Props {
  transparent?: boolean;
  showBackground?: boolean;
}

export function OverlayApp(props: Props = {}) {
  let backendClient: BackendPlaybackClient | null = null;

  onMount(() => {
    document.documentElement.classList.add('overlay-page');
    if (props.transparent) document.documentElement.classList.add('logo-overlay-page');
    const retryPending = () => backendClient?.retryPendingPlay();
    window.addEventListener('pointerdown', retryPending);
    onCleanup(() => {
      window.removeEventListener('pointerdown', retryPending);
      document.documentElement.classList.remove('overlay-page');
      document.documentElement.classList.remove('logo-overlay-page');
    });
  });

  const onReady = (audio: AudioEngine) => {
    backendClient?.dispose();
    backendClient = new BackendPlaybackClient({ audio });
    backendClient.start();
  };

  onCleanup(() => backendClient?.dispose());

  return (
    <Stage
      onReady={onReady}
      transparent={props.transparent}
      showBackground={props.showBackground ?? true}
    />
  );
}
