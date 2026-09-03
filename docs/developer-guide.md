<div align="center">

<a href="../README.md"><img src="../frontend/src/assets/worxbend-logo.png" width="72" alt="Lofi Radio" /></a>

# 🛠️ Developer Guide

### *Code map, playback flow, and how the pieces fit together.*

[🏠 Home](../README.md) · [🗺️ Overview](overview.md) · [🎧 User](user-guide.md) · **🛠️ Dev** · [🌐 API](api.md) · [🔌 WebSocket](websocket-protocol.md) · [⚙️ Config](configuration.md) · [🚀 Deploy](deployment.md)

</div>

---

## 🐳 Running In Containers

If you only want the app running, not a development loop:

```bash
docker compose up -d --build
```

See the [Deployment Guide](deployment.md) for the three compose files and every setting.
The rest of this page covers running the services directly, which is what you want when
editing code — the containers do not hot-reload.

## 📦 Prerequisites

- Go 1.25 or compatible with `backend/go.mod`.
- Node.js 20+.
- npm.
- No CGO toolchain required: the service uses no database driver.
- MP3 files for local playback.

## 🎛️ Backend Setup

```bash
cd backend
cp .env.example .env
cp config.example.toml config.toml
mkdir -p music
go mod download
go run cmd/api/main.go
```

The backend starts at `http://localhost:8080`.

## 🖼️ Frontend Setup

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

The frontend starts at `http://localhost:3000`.

## 🗺️ Backend Code Map

- `cmd/api/main.go`: startup, dependency wiring, graceful shutdown.
- `internal/config`: TOML and environment loading.
- `internal/repository`: in-memory song and queue stores.
- `internal/played`: Bloom-filter play-history tracker, persisted to a single file.
- `internal/repository`: database access for songs, queue, and history.
- `internal/queue`: song selection, queue operations, history start/finish.
- `internal/watcher`: startup scan and fsnotify create-event handling.
- `internal/api`: HTTP handlers under `/v1`.
- `internal/websocket`: protocol messages, hub, client session loop.
- `internal/meta`: ID3 metadata extraction.

## 🧭 Frontend Code Map

**Entry points** — `src/index.tsx` picks a root component from `window.location.pathname`.

- `src/App.tsx`: main scene, wires the playback client to the UI.
- `src/OverlayApp.tsx`: chrome-free scene for OBS browser sources.
- `src/SpectrumApp.tsx`: oscilloscope page, opaque or transparent.
- `src/AdminApp.tsx` / `src/admin.tsx`: admin console (separate `admin.html` bundle).

**Audio**

- `src/audio/BackendPlaybackClient.ts`: WebSocket controller — reconnect, heartbeat,
  outbox, prebuffering, and the typed `RadioStatus` reported to the UI.
- `src/audio/AudioEngine.ts`: two-channel playback, equal-power crossfade, FFT analyser.
- `src/audio/autoplay.ts`: decides whether audio may start without a user gesture.

**Rendering**

- `src/components/Stage.tsx`: Pixi application lifecycle and the ticker; takes a
  visualizer factory so each page can mount a different scene.
- `src/components/PlayerUI.tsx`: now-playing card, progress bar, clock, live badge.
- `src/viz/scenes.ts`: the scene catalogue. Adding a row here routes the scene,
  lists it on `/scenes` and documents it — there is no second place to update.
- `src/viz/WaveScene.ts`: shared base for the waveform and spectrum scenes.
  Owns the Pixi lifecycle, the backdrop and the bloom layer; subclasses only
  implement `draw()`.
- `src/viz/palette.ts`: the colour ramps, selectable per page with `?ramp=`.
- `src/viz/LofiRainVisualizer.ts`: the default rain scene.
- `src/viz/OscilloscopeVisualizer.ts`, `BarSpectrumVisualizer.ts`,
  `MirrorWaveVisualizer.ts`, `DotMatrixVisualizer.ts`, `RibbonVisualizer.ts`,
  `LineWaveVisualizer.ts`, `LensWaveVisualizer.ts`: the individual scenes.
- `src/viz/types.ts`: the `Visualizer` interface and the `AudioFrame` contract.

> [!IMPORTANT]
> `WaveScene` deliberately does not call its own `onResize()` hook from its
> constructor. A subclass's fields are not initialised until after `super()`
> returns, so an override touching subclass state would read `undefined`. The
> first `update()` primes it instead.

### 🎚️ Audio analysis

`src/audio/AudioAnalysisEngine.ts` turns raw analyser output into series that
are actually drawable, and every scene reads from it rather than touching an
`AnalyserNode`. It fixes three things about raw FFT data:

- **Log-spaced bands.** FFT bins are linear in frequency, so half a linear
  spectrum covers 11–22 kHz where there is nothing to see. Bands are spaced by
  octave instead, giving bass and treble equal screen width.
- **Tilt.** Musical energy falls off steeply with frequency, so an untreated
  spectrum looks like a cliff. About +4.5 dB per octave flattens it.
- **Envelope reduction.** Time-domain data is reduced to per-bucket minimum and
  maximum, not sampled every Nth point. Point sampling aliases badly: a loud
  steady tone becomes a thin flickering line, because each sample lands wherever
  the oscillation happens to be rather than at its extreme.

The two reductions live in `src/audio/analysisMath.ts` as pure functions so they
can be tested without a browser or an audio device.

## 🔄 Backend Playback Flow

1. Frontend opens `/ws`.
2. Frontend sends `need_song`.
3. Backend selects the next song, records a history start, and sends `play_song`.
4. Frontend sets `HTMLAudioElement.src` to the `stream_url`.
5. Browser streams from `/v1/songs/{id}/content`.
6. Frontend sends `song_finished` on media `ended`.
7. Backend marks the history entry finished and sends the next song.

## 📥 Queue Fill Behavior

`auto_refill` keeps `min_ahead` automatic songs queued after each selection. `preload` keeps `preload_size` songs queued. Manual queue additions are serialized with playback advancement, and queue position assignment is serialized in the in-memory repository so entries have deterministic ordering.

## 🛡️ WebSocket Resilience

`BackendPlaybackClient` is expected to run continuously:

- reconnects with capped exponential backoff;
- monitors browser network events;
- sends heartbeat messages;
- treats a quiet socket as stale and reconnects;
- queues outbound control messages while disconnected;
- re-requests music when connected and idle;
- retries pending playback after a user gesture if autoplay blocks;
- retries stream playback after media errors.

## 🔒 Backend-Only Frontend Mode

The frontend intentionally supports only backend streams:

- No local file picker.
- No microphone input.
- No visible play/pause button.
- The top-right chrome displays the current backend-provided song name under the clock.

This keeps playback state aligned with the backend protocol and avoids competing local audio modes.

## 🪟 Overlay Routes

`src/index.tsx` selects a root component by pathname:

| Pathname | Component | Transparent |
|:--|:--|:--|
| `/` | `App` | no |
| `/overlay` | `OverlayApp` | no |
| `/logo`, `/logo-overlay` | `OverlayApp` | yes |
| `/spectrum` | `SpectrumApp` | no |
| `/spectrum-overlay` | `SpectrumApp` | yes |

`?transparent=1` forces transparency on the spectrum routes.

Overlay routes add the `overlay-page` class to the document element, and transparent ones
also add `logo-overlay-page`, which drops the page background so OBS can composite the
canvas over other sources. Both classes are removed on cleanup, so switching routes in a
single-page session does not leave styling behind.

## ✅ Verification

```bash
cd backend
go test ./... -race     # queue strategies + websocket hub concurrency
go vet ./...
gofmt -l internal cmd   # should print nothing
```

```bash
cd frontend
npm test                # analysis maths, via node --test
npx tsc --noEmit        # typecheck only
npm run build           # typecheck + production bundle
```

Frontend tests run in plain Node with no test framework and no browser: Node
executes the TypeScript directly, and the functions under test are pure.

> [!NOTE]
> Run the backend tests with `-race`. Both of the concurrency bugs the hub tests cover were
> the kind that only show up under the race detector or under load. 🏁

The frontend build can warn about chunk size because Pixi and filters are large dependencies. That warning does not mean the build failed.

## ⚡ Performance Work

The visualizer targets WebGL rendering at 60 fps:

- Pixi is configured with WebGL preference and high-performance GPU mode.
- Device pixel ratio is capped to reduce fill-rate cost.
- Ticker is capped at 60 fps.
- Default bloom, chromatic split, and particle density are conservative.
- Several per-frame geometry arrays are reused instead of allocated.

Use browser dev tools performance profiling before increasing defaults.
