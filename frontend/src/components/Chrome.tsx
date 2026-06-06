import { createSignal, onMount, onCleanup } from 'solid-js';
import { config } from '../store/config';

export function Chrome() {
  const [clock, setClock] = createSignal('--:--');

  // Clock tick
  const updateClock = () => {
    const d = new Date();
    setClock(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  };
  updateClock();

  onMount(() => {
    const clockInt = setInterval(updateClock, 10000);

    onCleanup(() => {
      clearInterval(clockInt);
    });
  });

  return (
    <div id="chrome" class={config.chrome ? '' : 'hidden'}>
      <div class="live">
        <span class="badge"><span class="dot" />Live</span>
      </div>
      <div class="meta">
        <div class="clock">{clock()}</div>
        <div class="sub">lofi radio · 24/7 beats</div>
      </div>
    </div>
  );
}
