import { createSignal, onMount, onCleanup } from 'solid-js';
import type { AudioEngine } from '../audio/AudioEngine';

interface Props {
  trackName:   () => string;
  trackArtist: () => string;
  wsStatus:    () => 'connected' | 'reconnecting' | 'disconnected';
  audio:       () => AudioEngine | null;
}

export function PlayerUI(props: Props) {
  const [time, setTime] = createSignal('--:--');

  onMount(() => {
    const tickClock = () => {
      const d = new Date();
      setTime(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    };
    tickClock();
    const clockId = setInterval(tickClock, 30_000);
    onCleanup(() => clearInterval(clockId));
  });

  const liveDotClass = () =>
    props.wsStatus() === 'connected'    ? 'dot'          :
    props.wsStatus() === 'reconnecting' ? 'dot dot--warn' : 'dot dot--off';

  return (
    <>
      <div id="vignette" />
      <div id="grain" />

      <div id="chrome">
        {/* top-left: live badge */}
        <div class="live">
          <span class="badge">
            <span class={liveDotClass()} />
            Live
          </span>
        </div>

        {/* top-right: clock only */}
        <div class="meta">
          <div id="clock">{time()}</div>
        </div>

        {/* bottom-left: now playing — title only */}
        <div class="nowplaying">
          <div class="np-art" />
          <div class="np-info">
            <span class="np-label">Now Playing</span>
            <span id="np-title">{props.trackName()}</span>
          </div>
        </div>
      </div>
    </>
  );
}
