# Lofi Radio Backend

Go HTTP/WebSocket service for indexing MP3 files, streaming them over HTTP, managing a queue, and coordinating playback with the backend-only frontend.

## Run Locally

```bash
cp .env.example .env
cp config.example.toml config.toml
mkdir -p music
go mod download
go run cmd/api/main.go
```

Add `.mp3` files to `music/`. The service scans existing files on startup and watches for newly created files.

## Make Targets

```bash
make build
make run
make test
make watch
make clean
```

## Configuration

The backend reads `config.toml` unless `LOFI_CONFIG` points to another TOML file.

Environment variables override TOML values:

- `PORT`
- `BLUEPRINT_DB_URL`
- `MUSIC_DIR`
- `BASE_URL`

See `.env.example` and `config.example.toml`.

## Endpoints

- `GET /health`
- `GET /ws`
- `GET /v1/songs`
- `GET /v1/songs/{id}`
- `GET /v1/songs/{id}/content`
- `GET /v1/songs/{id}:stream`
- `GET /v1/queue`
- `POST /v1/queue`
- `DELETE /v1/queue/{id}`
- `POST /v1/queue:skip`
- `POST /v1/queue:clear`
- `GET /v1/history`
- `GET /v1/player`

## WebSocket Flow

Client sends:

```json
{"type":"need_song"}
```

Server sends:

```json
{"type":"play_song","payload":{"song":{},"stream_url":"http://localhost:8080/v1/songs/{id}/content","history_id":"...","queue_depth":0}}
```

Client sends when playback ends:

```json
{"type":"song_finished","payload":{"song_id":"...","history_id":"..."}}
```

The server records the history entry as finished and sends the next `play_song`.

## Development Notes

The supported deployment model is one active WebSocket playback client. The frontend client is resilient and reconnects automatically.

## Full Documentation

See the monorepo docs:

- `../docs/developer-guide.md`
- `../docs/api.md`
- `../docs/websocket-protocol.md`
- `../docs/configuration.md`
- `../docs/deployment.md`
