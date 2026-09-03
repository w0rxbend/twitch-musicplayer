import { render } from 'solid-js/web';
import { App } from './App';
import { OverlayApp } from './OverlayApp';
import { SceneApp } from './SceneApp';
import { ScenesIndex } from './ScenesIndex';
import { matchScene } from './viz/scenes';
import './styles/global.css';

const { pathname, search } = window.location;

const isOverlay = pathname === '/overlay';
const isLogoOverlay = ['/logo', '/logo-overlay'].includes(pathname);
const isScenesIndex = ['/scenes', '/scenes/'].includes(pathname);

// Any visualizer in the catalogue, opaque at /<slug> and transparent at
// /<slug>-overlay. Adding a scene to viz/scenes.ts routes it automatically.
const sceneRoute = matchScene(pathname, search);
const ramp = new URLSearchParams(search).get('ramp') ?? undefined;

render(
  () => {
    if (isLogoOverlay) return <OverlayApp transparent showBackground={false} />;
    if (isOverlay) return <OverlayApp />;
    if (isScenesIndex) return <ScenesIndex />;
    if (sceneRoute) {
      return (
        <SceneApp
          scene={sceneRoute.scene}
          transparent={sceneRoute.transparent}
          ramp={ramp}
        />
      );
    }
    return <App />;
  },
  document.getElementById('root')!,
);
