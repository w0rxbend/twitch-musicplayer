# Requirement Review

This document reviews the implementation against the original requested behavior.

## Implemented

### Go backend service

Implemented in `backend/` with Chi, Gorilla WebSocket, SQLite, fsnotify, and ID3 metadata extraction.

### go-blueprint style setup

The backend follows the generated-style layout with `cmd/api`, `internal/*`, `Makefile`, `.env`, and config files.

### Host files from a specified folder

Implemented through `MUSIC_DIR` and `[music].dir`. Startup scan and watcher index `.mp3` files.

### HTTP resource-oriented API

Implemented under `/v1`:

- Songs.
- Queue.
- History.
- Player summary.

Streaming endpoints use resource/action style:

- `/v1/songs/{id}/content`
- `/v1/songs/{id}:stream`

### WebSocket endpoint

Implemented at `/ws`.

### Single active WebSocket client model

Implemented as the supported deployment model. The frontend assumes it is the only playback client and drives queue/history progression.

### Client/server playback flow

Implemented:

```text
need_song -> play_song -> song_finished -> play_song
```

### Efficient frontend streaming

Implemented. The frontend assigns `stream_url` to `HTMLAudioElement.src`. It does not fetch the MP3 into JavaScript.

### History-backed automatic selection

Implemented. Default shuffle strategy is `round_robin`, which avoids automatic repeats until the known library cycles.

### Manual duplicate queue entries

Implemented. `POST /v1/queue` can manually add the same song multiple times.

### New file monitoring

Implemented for create events. Newly created files are indexed and added to the queue.

### Backend-only frontend mode

Implemented. Local file and microphone modes are removed from the supported frontend code path. Visible load/mic/play/tweaks buttons are removed. Tweaks are toggled with `T`.

### Resilient WebSocket frontend

Implemented. The frontend reconnects continuously with backoff, sends heartbeats, detects stale sockets, queues outbound control messages while disconnected, flushes them after reconnect, and retries pending playback/stream failures.

### Canvas/WebGL optimization

Implemented as a first pass:

- WebGL preference.
- 60 fps ticker cap.
- Lower resolution cap.
- Lower default effect density.
- Lower bloom quality.
- Lower geometry counts.
- Reused per-frame geometry buffers.

## Partially Implemented

### Health endpoint

Partially implemented. `/health` exists, but the response is minimal and should be improved for production.

## Not Implemented Yet

- File deletion reconciliation.
- Authentication/authorization for queue mutation.
- Production-grade WebSocket origin restrictions.
- Full test coverage for queue/history/protocol behavior.
- Global current-song state exposed by `/v1/player`.
