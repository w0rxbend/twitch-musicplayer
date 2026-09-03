import { render } from 'solid-js/web';
import { App } from './App';
import { OverlayApp } from './OverlayApp';
import { SpectrumApp } from './SpectrumApp';
import './styles/global.css';

const pathname = window.location.pathname;
const isOverlay = pathname === '/overlay';
const isLogoOverlay = ['/logo', '/logo-overlay'].includes(pathname);
const isSpectrum = ['/spectrum', '/spectrum-overlay'].includes(pathname);
const transparentSpectrum =
  pathname === '/spectrum-overlay' ||
  new URLSearchParams(window.location.search).get('transparent') === '1';

render(
  () => {
    if (isLogoOverlay) return <OverlayApp transparent showBackground={false} />;
    if (isOverlay) return <OverlayApp />;
    if (isSpectrum) return <SpectrumApp transparent={transparentSpectrum} />;
    return <App />;
  },
  document.getElementById('root')!,
);
