import { createSignal, onMount, onCleanup, For } from 'solid-js';
import { config, setConfig } from '../store/config';
import { VIZ2_PALETTES } from '../viz/config';

interface Props {
  open: boolean;
  onClose: () => void;
}

function TweakSlider(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div class="twk-row">
      <div class="twk-lbl">
        <span>{props.label}</span>
        <span class="twk-val">{props.value.toFixed(2)}</span>
      </div>
      <input
        class="twk-slider"
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) => props.onChange(parseFloat((e.currentTarget as HTMLInputElement).value))}
      />
    </div>
  );
}

function TweakToggle(props: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div class="twk-row twk-row-h">
      <span class="twk-lbl"><span>{props.label}</span></span>
      <button
        class="twk-toggle"
        data-on={props.value ? '1' : '0'}
        onClick={() => props.onChange(!props.value)}
        aria-pressed={props.value}
      >
        <i />
      </button>
    </div>
  );
}

function TweakRadio(props: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div class="twk-row">
      <div class="twk-lbl"><span>{props.label}</span></div>
      <div class="twk-seg">
        <div
          class="twk-seg-thumb"
          style={{
            left: `${(props.options.findIndex(o => o.value === props.value) / props.options.length) * 100}%`,
            width: `${100 / props.options.length}%`,
          }}
        />
        <For each={props.options}>
          {(opt) => (
            <button
              class={opt.value === props.value ? 'active' : ''}
              onClick={() => props.onChange(opt.value)}
            >
              {opt.label}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

function TweakText(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div class="twk-row">
      <div class="twk-lbl"><span>{props.label}</span></div>
      <input
        class="twk-field"
        type="text"
        value={props.value}
        placeholder={props.label}
        onInput={(e) => props.onChange((e.currentTarget as HTMLInputElement).value)}
      />
    </div>
  );
}

export function TweaksPanel(props: Props) {
  let panelRef!: HTMLDivElement;

  // Drag to move
  let dragOff = { x: 0, y: 0 };
  let dragging = false;

  const onHeaderDown = (e: MouseEvent) => {
    dragging = true;
    const rect = panelRef.getBoundingClientRect();
    dragOff.x = e.clientX - rect.left;
    dragOff.y = e.clientY - rect.top;
    e.preventDefault();
  };

  onMount(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const x = e.clientX - dragOff.x;
      const y = e.clientY - dragOff.y;
      panelRef.style.left = `${x}px`;
      panelRef.style.right = 'auto';
      panelRef.style.top = `${y}px`;
      panelRef.style.bottom = 'auto';
    };
    const onUp = () => { dragging = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    onCleanup(() => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    });
  });

  const paletteNames = Object.keys(VIZ2_PALETTES);
  const paletteValues = Object.values(VIZ2_PALETTES);

  const activePaletteIdx = () => {
    const cur = config.palette.join(',');
    return paletteValues.findIndex(p => p.join(',') === cur);
  };

  return (
    <div class={`twk-panel${props.open ? '' : ' hidden'}`} ref={panelRef!}>
      <div class="twk-hd" onMouseDown={onHeaderDown}>
        <b>Tweaks</b>
        <button class="twk-x" onClick={props.onClose}>✕</button>
      </div>
      <div class="twk-body">
        <div class="twk-sect">Color</div>

        <div class="twk-row">
          <div class="twk-lbl"><span>Palette</span></div>
          <div class="pal-grid">
            <For each={paletteNames}>
              {(name, i) => (
                <button
                  class={`pal-preset${activePaletteIdx() === i() ? ' active' : ''}`}
                  onClick={() => setConfig('palette', paletteValues[i()])}
                >
                  <div class="swatch-row">
                    <For each={paletteValues[i()].slice(0, 5)}>
                      {(c) => <span class="swatch" style={{ background: c }} />}
                    </For>
                  </div>
                  <span class="pal-name">{name}</span>
                </button>
              )}
            </For>
          </div>
        </div>

        <TweakToggle
          label="Rainbow cycle"
          value={config.colorCycle}
          onChange={(v) => setConfig('colorCycle', v)}
        />
        <TweakSlider
          label="Cycle speed"
          value={config.cycleSpeed}
          min={0} max={4} step={0.1}
          onChange={(v) => setConfig('cycleSpeed', v)}
        />
        <TweakRadio
          label="Scene"
          value={config.scene}
          options={[{ value: 'mountains', label: 'Mountains' }, { value: 'space', label: 'Deep space' }]}
          onChange={(v) => setConfig('scene', v as 'mountains' | 'space')}
        />

        <div class="twk-sect">Energy</div>
        <TweakSlider
          label="Intensity"
          value={config.intensity} min={0.4} max={2.2} step={0.05}
          onChange={(v) => setConfig('intensity', v)}
        />
        <TweakSlider
          label="Bass response"
          value={config.bass} min={0.4} max={2.2} step={0.05}
          onChange={(v) => setConfig('bass', v)}
        />
        <TweakSlider
          label="Bloom"
          value={config.bloom} min={0} max={2.2} step={0.05}
          onChange={(v) => setConfig('bloom', v)}
        />
        <TweakSlider
          label="Chromatic split"
          value={config.aberration} min={0} max={2.5} step={0.05}
          onChange={(v) => setConfig('aberration', v)}
        />
        <TweakSlider
          label="Particles"
          value={config.density} min={0.3} max={2.2} step={0.1}
          onChange={(v) => setConfig('density', v)}
        />

        <div class="twk-sect">Stream overlay</div>
        <TweakToggle
          label="Show overlay"
          value={config.chrome}
          onChange={(v) => setConfig('chrome', v)}
        />
        <TweakText
          label="Track"
          value={config.trackTitle}
          onChange={(v) => setConfig('trackTitle', v)}
        />
        <TweakText
          label="Caption"
          value={config.trackArtist}
          onChange={(v) => setConfig('trackArtist', v)}
        />
      </div>
    </div>
  );
}
