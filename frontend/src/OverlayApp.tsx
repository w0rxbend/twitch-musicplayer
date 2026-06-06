import { onCleanup, onMount } from 'solid-js';
import { BackendPlaybackClient } from './audio/BackendPlaybackClient';
import type { AudioEngine } from './audio/AudioEngine';
import { LogoOverlayStage } from './components/LogoOverlayStage';

export function OverlayApp() {
  let backendClient: BackendPlaybackClient | null = null;

  onMount(() => {
    document.body.classList.add('overlay-page');
    const retryPending = () => backendClient?.retryPendingPlay();
    window.addEventListener('pointerdown', retryPending);

    onCleanup(() => {
      window.removeEventListener('pointerdown', retryPending);
      document.body.classList.remove('overlay-page');
    });
  });

  const onReady = (audio: AudioEngine) => {
    backendClient?.dispose();
    backendClient = new BackendPlaybackClient({ audio });
    backendClient.start();
  };

  onCleanup(() => backendClient?.dispose());

  return <LogoOverlayStage onReady={onReady} />;
}
