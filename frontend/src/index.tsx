import { render } from 'solid-js/web';
import { App } from './App';
import { OverlayApp } from './OverlayApp';
import './styles/global.css';

const isOverlay = ['/overlay', '/logo-overlay'].includes(window.location.pathname);

render(() => isOverlay ? <OverlayApp /> : <App />, document.getElementById('root')!);
