import { createSignal, onMount, onCleanup } from 'solid-js';
import { config, setConfig } from '../store/config';
import { showHint } from '../store/hint';
import type { AudioEngine } from '../audio/AudioEngine';

interface Props {
  audio: AudioEngine | null;
  onTweaksToggle: () => void;
  tweaksOpen: boolean;
}

export function Chrome(props: Props) {
  const [clock, setClock] = createSignal('--:--');
  const [playing, setPlaying] = createSignal(false);
  const [micActive, setMicActive] = createSignal(false);

  let eqRefs: HTMLElement[] = [];
  let fileInput!: HTMLInputElement;

  // Clock tick
  const updateClock = () => {
    const d = new Date();
    setClock(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  };
  updateClock();

  onMount(() => {
    const clockInt = setInterval(updateClock, 10000);

    // EQ bars rAF
    let raf: number;
    const updateEq = () => {
      const a = props.audio;
      if (a && eqRefs.length) {
        const s = a.spectrum;
        eqRefs.forEach((bar, i) => {
          const bin = 4 + i * 14;
          const v = s[Math.min(bin, s.length - 1)] || 0;
          bar.style.transform = `scaleY(${0.2 + v * 0.8})`;
        });
      }
      raf = requestAnimationFrame(updateEq);
    };
    raf = requestAnimationFrame(updateEq);

    onCleanup(() => {
      clearInterval(clockInt);
      cancelAnimationFrame(raf);
    });
  });

  const handleFile = async (e: Event) => {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!f || !props.audio) return;
    const name = await props.audio.loadFile(f);
    setConfig('trackTitle', name);
    setPlaying(true);
    showHint(`▶ ${name}`);
  };

  const handleMic = async () => {
    if (!props.audio) return;
    try {
      await props.audio.enableMic();
      setMicActive(true);
      showHint('microphone active');
    } catch {
      showHint('mic access denied');
    }
  };

  const handlePlay = () => {
    if (!props.audio) return;
    const isPlaying = props.audio.togglePlay();
    setPlaying(isPlaying);
  };

  return (
    <>
      <div id="chrome" class={config.chrome ? '' : 'hidden'}>
        <div class="live">
          <span class="badge"><span class="dot" />Live</span>
        </div>
        <div class="meta">
          <div class="clock">{clock()}</div>
          <div class="sub">lofi radio · 24/7 beats</div>
        </div>

        <div class="nowplaying">
          <div class="np-art" />
          <div class="np-info">
            <span class="np-label">Now Playing</span>
            <span class="np-title">{config.trackTitle}</span>
            <div class="np-bottom">
              <span class="np-artist">{config.trackArtist}</span>
              <span class="np-eq">
                {[0,1,2,3,4,5,6].map(i => (
                  <i ref={(el) => { eqRefs[i] = el; }} />
                ))}
              </span>
            </div>
          </div>
        </div>

        <div class="controls">
          <button
            class="ctrl"
            title="Load an audio file"
            onClick={() => fileInput.click()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 18V5l12-2v13"/>
              <circle cx="6" cy="18" r="3"/>
              <circle cx="18" cy="16" r="3"/>
            </svg>
          </button>
          <button
            class={`ctrl${micActive() ? ' active' : ''}`}
            title="Use microphone"
            onClick={handleMic}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="2" width="6" height="12" rx="3"/>
              <path d="M5 10a7 7 0 0 0 14 0"/>
              <line x1="12" y1="17" x2="12" y2="22"/>
            </svg>
          </button>
          <button
            class={`ctrl${playing() ? ' active' : ''}`}
            title="Play / pause"
            onClick={handlePlay}
          >
            {playing() ? '⏸' : '▶'}
          </button>
          <button
            class={`ctrl${props.tweaksOpen ? ' active' : ''}`}
            title="Tweaks"
            onClick={props.onTweaksToggle}
          >
            ⚙
          </button>
        </div>
      </div>

      <input
        id="file-input"
        type="file"
        accept="audio/*"
        class="hidden"
        ref={fileInput!}
        onChange={handleFile}
      />
    </>
  );
}
