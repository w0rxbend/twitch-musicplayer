import { render } from 'solid-js/web';
import { App } from './App';
import { OverlayApp } from './OverlayApp';
import './styles/global.css';

const pathname = window.location.pathname;
const isOverlay = pathname === '/overlay';
const isLogoOverlay = ['/logo', '/logo-overlay'].includes(pathname);

render(
  () => {
    if (isLogoOverlay) return <OverlayApp transparent showBackground={false} />;
    if (isOverlay) return <OverlayApp />;
    return <App />;
  },
  document.getElementById('root')!,
);
