# User Guide

## What This App Does

The app plays MP3 files from the backend music folder and renders a lofi visualizer. Playback is controlled by the backend. The frontend does not load local files and does not use microphone input.

## Running Locally

1. Start the backend.
2. Start the frontend.
3. Open `http://localhost:3000`.
4. If the browser blocks autoplay, click or tap anywhere once.
5. Press `T` to open or close visual tweaks.

## Adding Music

Copy `.mp3` files into the configured backend music folder. By default:

```text
backend/music
```

Existing files are scanned when the backend starts. Newly created files are detected while the backend is running and added to the queue automatically.

## Visual Tweaks

Press `T` to open the tweaks panel. Available settings include:

- Palette.
- Color cycling.
- Scene.
- Intensity.
- Bass response.
- Bloom.
- Chromatic split.
- Particle density.
- Overlay visibility.

The visible load/microphone/play buttons have intentionally been removed. The top-right chrome shows the current backend-provided song name under the clock.

## Logo Overlay

Open either overlay route when you need a transparent logo-style source:

```text
http://localhost:3000/overlay
http://localhost:3000/logo-overlay
```

The overlay uses the same backend WebSocket/audio playback path as the main page, but renders only a transparent Pixi canvas with fluid circular audio-reactive lines. It is intended for OBS/browser-source overlays and other compositing workflows.

Overlay routes try to start audio automatically for OBS browser sources. The main page keeps normal browser autoplay protection unless opened with `?autoplay=1` or built with `VITE_AUTO_START_AUDIO=true`.

## Queue Control

Third-party tools can control the queue through the HTTP API. For example:

```bash
curl http://localhost:8080/v1/songs
curl -X POST http://localhost:8080/v1/queue \
  -H 'Content-Type: application/json' \
  -d '{"song_id":"SONG_ID"}'
```

Manual queue additions can repeat a song. Automatic playback uses `round_robin` by default to avoid repeating until the library cycles.
