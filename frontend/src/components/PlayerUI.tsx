import { createSignal, onMount, onCleanup, createEffect, on } from 'solid-js';
import type { AudioEngine } from '../audio/AudioEngine';

interface Props {
  trackName:   () => string;
  trackArtist: () => string;
  wsStatus:    () => 'connected' | 'reconnecting' | 'disconnected';
  audio:       () => AudioEngine | null;
}

function fmtTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function PlayerUI(props: Props) {
  const [time, setTime] = createSignal('--:--');
  const [fraction, setFraction] = createSignal(0);
  const [elapsed, setElapsed] = createSignal('0:00');
  const [remaining, setRemaining] = createSignal('0:00');
  const [reveal, setReveal] = createSignal(true);

  onMount(() => {
    const tickClock = () => {
      const d = new Date();
      setTime(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    };
    tickClock();
    const clockId = setInterval(tickClock, 30_000);
    onCleanup(() => clearInterval(clockId));

    // Smooth progress bar, driven by the active audio element.
    let raf = 0;
    let lastSec = -1;
    const tick = () => {
      const prog = props.audio()?.getPlaybackProgress?.() ?? null;
      if (prog && prog.duration > 0) {
        const f = Math.min(1, Math.max(0, prog.currentTime / prog.duration));
        setFraction(f);
        const es = Math.floor(prog.currentTime);
        if (es !== lastSec) {
          lastSec = es;
          setElapsed(fmtTime(prog.currentTime));
          setRemaining('-' + fmtTime(prog.duration - prog.currentTime));
        }
      } else {
        setFraction(0);
        if (lastSec !== -1) { lastSec = -1; setElapsed('0:00'); setRemaining('0:00'); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  // Re-trigger the reveal animation each time the track changes.
  createEffect(on(() => props.trackName(), () => {
    setReveal(false);
    requestAnimationFrame(() => requestAnimationFrame(() => setReveal(true)));
  }, { defer: true }));

  const liveDotClass = () =>
    props.wsStatus() === 'connected'    ? 'dot'          :
    props.wsStatus() === 'reconnecting' ? 'dot dot--warn' : 'dot dot--off';

  const liveLabel = () =>
    props.wsStatus() === 'connected'    ? 'Live'         :
    props.wsStatus() === 'reconnecting' ? 'Reconnecting' : 'Offline';

  return (
    <>
      <div id="vignette" />
      <div id="grain" />

      <div id="chrome">
        {/* top-left: live badge */}
        <div class="live">
          <span class="badge">
            <span class={liveDotClass()} />
            {liveLabel()}
          </span>
        </div>

        {/* top-right: clock only */}
        <div class="meta">
          <div id="clock">{time()}</div>
        </div>

        {/* bottom-left: now playing */}
        <div class="nowplaying">
          <div class="np-art" />
          <div class="np-info" classList={{ 'np-reveal': reveal() }}>
            <span class="np-label">Now Playing</span>
            <span id="np-title">{props.trackName()}</span>
            <span id="np-artist">{props.trackArtist()}</span>
            <div class="np-progress">
              <div class="np-bar">
                <div class="np-bar-fill" style={{ width: `${fraction() * 100}%` }} />
              </div>
              <div class="np-times">
                <span>{elapsed()}</span>
                <span>{remaining()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
