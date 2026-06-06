# Developer Guide

## Prerequisites

- Go 1.25 or compatible with `backend/go.mod`.
- Node.js 20+.
- npm.
- CGO toolchain for `github.com/mattn/go-sqlite3`.
- MP3 files for local playback.

## Backend Setup

```bash
cd backend
cp .env.example .env
cp config.example.toml config.toml
mkdir -p music
go mod download
go run cmd/api/main.go
```

The backend starts at `http://localhost:8080`.

## Frontend Setup

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

The frontend starts at `http://localhost:3000`.

## Backend Code Map

- `cmd/api/main.go`: startup, dependency wiring, graceful shutdown.
- `internal/config`: TOML and environment loading.
- `internal/database`: SQLite connection and migrations.
- `internal/repository`: database access for songs, queue, and history.
- `internal/queue`: song selection, queue operations, history start/finish.
- `internal/watcher`: startup scan and fsnotify create-event handling.
- `internal/api`: HTTP handlers under `/v1`.
- `internal/websocket`: protocol messages, hub, client session loop.
- `internal/meta`: ID3 metadata extraction.

## Frontend Code Map

- `src/App.tsx`: app lifecycle, backend playback startup, `T` hotkey.
- `src/audio/BackendPlaybackClient.ts`: WebSocket controller.
- `src/audio/AudioEngine.ts`: backend stream playback and analyser.
- `src/components/Stage.tsx`: Pixi application lifecycle.
- `src/components/LogoOverlayStage.tsx`: transparent Pixi overlay lifecycle.
- `src/viz/Visualizer.ts`: WebGL visual rendering.
- `src/viz/LogoOverlayVisualizer.ts`: circular logo overlay renderer.
- `src/components/TweaksPanel.tsx`: visual tweak controls.
- `src/components/Chrome.tsx`: minimal live/time overlay.

## Backend Playback Flow

1. Frontend opens `/ws`.
2. Frontend sends `need_song`.
3. Backend selects the next song, records a history start, and sends `play_song`.
4. Frontend sets `HTMLAudioElement.src` to the `stream_url`.
5. Browser streams from `/v1/songs/{id}/content`.
6. Frontend sends `song_finished` on media `ended`.
7. Backend marks the history entry finished and sends the next song.

## Queue Fill Behavior

`auto_refill` keeps `min_ahead` automatic songs queued after each selection. `preload` keeps `preload_size` songs queued. Manual queue additions are serialized with playback advancement, and SQLite queue position assignment is serialized in the repository so entries have deterministic ordering.

## WebSocket Resilience

`BackendPlaybackClient` is expected to run continuously:

- reconnects with capped exponential backoff;
- monitors browser network events;
- sends heartbeat messages;
- treats a quiet socket as stale and reconnects;
- queues outbound control messages while disconnected;
- re-requests music when connected and idle;
- retries pending playback after a user gesture if autoplay blocks;
- retries stream playback after media errors.

## Backend-Only Frontend Mode

The frontend intentionally supports only backend streams:

- No local file picker.
- No microphone input.
- No visible play/pause button.
- No now-playing metadata block.

This keeps playback state aligned with the backend protocol and avoids competing local audio modes.

## Overlay Routes

The frontend selects the overlay app by pathname:

- `/overlay`
- `/logo-overlay`

Both routes use `OverlayApp`, `LogoOverlayStage`, and `LogoOverlayVisualizer`. The document body receives `overlay-page`, which makes the page background transparent for compositing.

## Verification

```bash
cd backend
go test ./...
```

```bash
cd frontend
npm run build
```

The frontend build can warn about chunk size because Pixi and filters are large dependencies. That warning does not mean the build failed.

## Performance Work

The visualizer targets WebGL rendering at 60 fps:

- Pixi is configured with WebGL preference and high-performance GPU mode.
- Device pixel ratio is capped to reduce fill-rate cost.
- Ticker is capped at 60 fps.
- Default bloom, chromatic split, and particle density are conservative.
- Several per-frame geometry arrays are reused instead of allocated.

Use browser dev tools performance profiling before increasing defaults.
