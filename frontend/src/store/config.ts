import { createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import { TWEAK_DEFAULTS } from '../viz/config';
import type { VizConfig } from '../viz/types';

const { config, setConfig } = createRoot(() => {
  const [c, s] = createStore<VizConfig>({ ...TWEAK_DEFAULTS });
  return { config: c, setConfig: s };
});

export { config, setConfig };
