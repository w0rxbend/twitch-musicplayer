/**
 * Resolves where the backend lives, from the most specific source available.
 *
 * 1. Runtime config — `window.__LOFI_CONFIG__.backendUrl`, written by
 *    `/config.js`. The Docker image generates that file from the `BACKEND_URL`
 *    environment variable when the container starts, so one published image can
 *    point at any host without being rebuilt.
 * 2. Build-time config — `VITE_BACKEND_URL`, baked in by Vite. Used by
 *    `npm run dev` and by locally built images.
 * 3. Fallback — the host that served the page, on port 8080. Correct whenever
 *    the backend is published on the same machine as the frontend, which is the
 *    default Compose layout.
 */

declare global {
  interface Window {
    __LOFI_CONFIG__?: { backendUrl?: string };
  }
}

const DEFAULT_BACKEND_PORT = 8080;

function clean(value: string | undefined | null): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

export function getBackendURL(): string {
  const runtime = clean(window.__LOFI_CONFIG__?.backendUrl);
  if (runtime) return runtime;

  const built = clean(import.meta.env.VITE_BACKEND_URL as string | undefined);
  if (built) return built;

  return `${window.location.protocol}//${window.location.hostname}:${DEFAULT_BACKEND_PORT}`;
}

/** The `/ws` endpoint, with the scheme upgraded to match the page's security. */
export function getWebSocketURL(): string {
  const url = new URL(getBackendURL());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  return url.toString();
}

/** Turns a possibly-relative stream URL from the backend into an absolute one. */
export function resolveStreamURL(url: string): string {
  return new URL(url, getBackendURL()).toString();
}
