import { For, onCleanup, onMount } from 'solid-js';
import { SCENES } from './viz/scenes';

/**
 * The scene picker at /scenes.
 *
 * Its job is to make setting up OBS quick: every scene is listed with its
 * opaque and transparent URLs, and clicking a URL copies it so it can be pasted
 * straight into a browser source.
 */
export function ScenesIndex() {
  onMount(() => {
    document.documentElement.classList.add('scenes-index-page');
    onCleanup(() => document.documentElement.classList.remove('scenes-index-page'));
  });

  const origin = () => window.location.origin;

  const copy = (url: string, el: HTMLElement) => {
    void navigator.clipboard?.writeText(url).then(
      () => {
        const previous = el.textContent;
        el.textContent = 'copied ✓';
        window.setTimeout(() => { el.textContent = previous; }, 1200);
      },
      () => { /* clipboard blocked; the URL is still readable on screen */ },
    );
  };

  return (
    <div class="scenes-shell">
      <header class="scenes-header">
        <h1>🎨 Visualizer Scenes</h1>
        <p>
          Every scene is its own page, built to be an OBS browser source. Use the
          <strong> overlay </strong> link for a transparent background, and add
          <code> ?ramp=NEON </code> to recolour any of them.
        </p>
      </header>

      <div class="scenes-grid">
        <For each={SCENES}>
          {(scene) => (
            <article class="scene-card">
              <div class="scene-card-icon">{scene.icon}</div>
              <h2>{scene.label}</h2>
              <p>{scene.description}</p>
              <div class="scene-links">
                <a class="scene-open" href={`/${scene.slug}`}>Open ▶</a>
                <a class="scene-open scene-open--ghost" href={`/${scene.slug}-overlay`}>
                  Overlay ▶
                </a>
              </div>
              <div class="scene-urls">
                <button
                  class="scene-url"
                  onClick={(e) => copy(`${origin()}/${scene.slug}`, e.currentTarget)}
                >
                  /{scene.slug}
                </button>
                <button
                  class="scene-url"
                  onClick={(e) => copy(`${origin()}/${scene.slug}-overlay`, e.currentTarget)}
                >
                  /{scene.slug}-overlay
                </button>
              </div>
            </article>
          )}
        </For>
      </div>

      <footer class="scenes-footer">
        <span>Colour ramps: SPECTRUM · AURORA · EMBER · NEON · VU</span>
        <a href="/admin">Admin console →</a>
      </footer>
    </div>
  );
}
