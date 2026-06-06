import { createSignal, onCleanup, onMount } from 'solid-js';
import { Stage } from './components/Stage';
import { PlayerUI } from './components/PlayerUI';
import { BackendPlaybackClient } from './audio/BackendPlaybackClient';
import type { AudioEngine } from './audio/AudioEngine';

type WsStatus = 'connected' | 'reconnecting' | 'disconnected';

export function App() {
  const [audio, setAudio]           = createSignal<AudioEngine | null>(null);
  const [trackName, setTrackName]   = createSignal('waiting for track…');
  const [trackArtist, setTrackArtist] = createSignal('lofi radio · 24/7');
  const [wsStatus, setWsStatus]     = createSignal<WsStatus>('disconnected');
  let backendClient: BackendPlaybackClient | null = null;

  onMount(() => {
    const handlePointerDown = () => backendClient?.retryPendingPlay();
    window.addEventListener('pointerdown', handlePointerDown);
    onCleanup(() => window.removeEventListener('pointerdown', handlePointerDown));
  });

  const onReady = (a: AudioEngine) => {
    setAudio(a);
    backendClient?.dispose();
    backendClient = new BackendPlaybackClient({
      audio: a,
      onStatus: (msg) => {
        if (msg.toLowerCase().includes('connect'))    setWsStatus('connected');
        else if (msg.toLowerCase().includes('reconnect')) setWsStatus('reconnecting');
        else if (msg.toLowerCase().includes('disconnect')) setWsStatus('disconnected');
      },
      onSongChange: (song) => {
        setTrackName(song?.title   || 'waiting for track…');
        setTrackArtist(song?.artist || 'lofi radio · 24/7');
      },
    });
    backendClient.start();
    setWsStatus('connected');
  };

  onCleanup(() => backendClient?.dispose());

  return (
    <>
      <Stage onReady={onReady} />
      <PlayerUI
        trackName={trackName}
        trackArtist={trackArtist}
        wsStatus={wsStatus}
        audio={audio}
      />
    </>
  );
}
