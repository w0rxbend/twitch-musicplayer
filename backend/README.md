<div align="center">

# 🎛️ Lofi Radio — Backend

**The DJ.** Indexes your MP3s, decides what plays next, streams the bytes, and tells every
connected client what to do over WebSocket.

`Go 1.25` · `Chi` · `Gorilla WebSocket` · `fsnotify` · `Bloom filter` · **no database**

</div>

---

## 🚀 Run Locally

```bash
cp .env.example .env
cp config.example.toml config.toml
mkdir -p music
go mod download
go run cmd/api/main.go
```

Drop `.mp3` files into `music/`. Existing files are scanned at startup and new ones are
picked up live by the filesystem watcher — including files added to nested subfolders. 📁

## 🔨 Make Targets

```bash
make build   # compile the binary
make run     # build and run
make test    # go test ./...
make watch   # live reload during development
make clean   # remove build artifacts
```

## ⚙️ Configuration

The backend reads `config.toml` unless `LOFI_CONFIG` points at another TOML file.
Environment variables take precedence over TOML values:

| Variable | Overrides | Default |
|:--|:--|:--|
| `LOFI_CONFIG` | config file location | `config.toml` |
| `PORT` | `server.port` | `8080` |
| `BASE_URL` | `server.base_url` | `http://localhost:8080` |
| `MUSIC_DIR` | `music.dir` | `./music` |
| `BLOOM_PATH` | `bloom.path` | `./lofi-radio.bloom` |

Shuffle and queue strategies are TOML-only. See `.env.example` and `config.example.toml`.

## 🌐 Endpoints

**Service**

| Method | Path | Purpose |
|:--|:--|:--|
| `GET` | `/health` | Liveness probe |
| `GET` | `/ws` | WebSocket playback channel |
| `GET` | `/swagger` | Interactive API explorer |
| `GET` | `/openapi.yaml` | Raw OpenAPI spec |

**Songs**

| Method | Path | Purpose |
|:--|:--|:--|
| `GET` | `/v1/songs` | List the library (`?q=` to search title/artist/album/filename) |
| `GET` | `/v1/songs/{id}` | One song's metadata |
| `GET` | `/v1/songs/{id}/content` | Stream audio bytes — supports HTTP Range, so seeking works |
| `GET` | `/v1/songs/{id}:stream` | Alias of `/content` |

**Queue**

| Method | Path | Purpose |
|:--|:--|:--|
| `GET` | `/v1/queue` | Current queue, song metadata included |
| `POST` | `/v1/queue` | Append a song — body `{"song_id":"..."}` |
| `DELETE` | `/v1/queue/{id}` | Remove one queue entry by **queue item** ID |
| `POST` | `/v1/queue:skip` | Advance to the next song |
| `POST` | `/v1/queue:clear` | Empty the queue |
| `POST` | `/v1/queue:play-next` | Jump a song to the front and broadcast `skip_now` |

**Player**

| Method | Path | Purpose |
|:--|:--|:--|
| `GET` | `/v1/player` | Current song, queue length, library size |
| `POST` | `/v1/player:skip` | Broadcast `skip_now` to every audio client |

## 🔌 WebSocket Flow

Client announces it is ready:

```json
{"type":"need_song"}
```

Server picks a track and replies:

```json
{"type":"play_song","payload":{"song":{},"stream_url":"http://localhost:8080/v1/songs/{id}/content","history_id":"...","queue_depth":0}}
```

Client reports the track is done — in practice sent a few seconds *early*, to start the
crossfade before the audio actually runs out:

```json
{"type":"song_finished","payload":{"song_id":"...","history_id":"..."}}
```

The server selects the next track and sends another `play_song`. Between those, the client
may send `{"type":"peek_next"}` to have the next URL buffered without dequeuing it. 🎚️

> `history_id` is a per-playback correlation ID generated fresh for each `play_song`. It
> lets the client ignore stale callbacks from a track that has already been replaced. It is
> **not** persisted — there is no history store.

## 🗃️ Why there is no database

Song IDs are UUIDv5 hashes of the absolute file path, so they are stable across restarts
without being stored anywhere. Play history lives in a Bloom filter that is written to a
single file on shutdown and reloaded at startup.

Bloom filters have no false negatives but do have false positives, so a song may
occasionally be treated as already-played and skipped within a rotation cycle. That is the
accepted trade for zero migrations, zero CGO, and an index that starts cold instantly.

## 🧪 Tests

```bash
go test ./... -race
```

Covers the queue strategies (full-cycle coverage, no back-to-back artists, recency
weighting) and the WebSocket hub's concurrency behaviour.

## 📚 Full Documentation

- [`../docs/developer-guide.md`](../docs/developer-guide.md)
- [`../docs/api.md`](../docs/api.md)
- [`../docs/websocket-protocol.md`](../docs/websocket-protocol.md)
- [`../docs/configuration.md`](../docs/configuration.md)
- [`../docs/deployment.md`](../docs/deployment.md)
