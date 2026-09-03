<div align="center">

<a href="../README.md"><img src="../frontend/src/assets/worxbend-logo.png" width="72" alt="Lofi Radio" /></a>

# ⚙️ Configuration

### *Every TOML key and environment override, and what they change.*

[🏠 Home](../README.md) · [🗺️ Overview](overview.md) · [🎧 User](user-guide.md) · [🛠️ Dev](developer-guide.md) · [🌐 API](api.md) · [🔌 WebSocket](websocket-protocol.md) · **⚙️ Config** · [🚀 Deploy](deployment.md)

</div>

---

## 📄 Backend TOML

Example: `backend/config.example.toml`.

```toml
[server]
port = 8080
base_url = "http://localhost:8080"

[database]
path = "./lofi-radio.db"

[music]
dir = "./music"
extensions = [".mp3", ".MP3"]

[shuffle]
strategy = "round_robin"
recent_window = 0

[queue]
strategy = "auto_refill"
min_ahead = 1
preload_size = 3
```

Set `LOFI_CONFIG` to use a custom TOML file:

```bash
LOFI_CONFIG=/etc/lofi/config.toml ./lofi-radio-backend
```

## 🌱 Backend Environment

Example: `backend/.env.example`.

```bash
PORT=8080
APP_ENV=local
BLOOM_PATH=./lofi-radio.bloom
MUSIC_DIR=./music
BASE_URL=http://localhost:8080
```

Environment variables override TOML values:

| Variable | Overrides | Default |
|:--|:--|:--|
| `LOFI_CONFIG` | path to the TOML file itself | `config.toml` |
| `PORT` | `server.port` | `8080` |
| `BASE_URL` | `server.base_url` | `http://localhost:8080` |
| `MUSIC_DIR` | `music.dir` | `./music` |
| `BLOOM_PATH` | `bloom.path` | `./lofi-radio.bloom` |

`APP_ENV` appears in `.env.example` for convention but is not read by the service.
Shuffle and queue settings are TOML-only — there is no environment override for them.

## 🖼️ Frontend Environment

Example: `frontend/.env.example`.

```bash
VITE_BACKEND_URL=http://localhost:8080
VITE_AUTO_START_AUDIO=false
```

`VITE_BACKEND_URL` is used to derive:

- WebSocket URL: `ws://.../ws` or `wss://.../ws`.
- Relative stream URL resolution.

`VITE_AUTO_START_AUDIO=true` lets the frontend try to start playback without a browser click. Overlay routes enable this by default for OBS/browser-source use; the main page can also opt in with `?autoplay=1`.

## 📋 Queue Strategies

Controls **when** the queue is topped up. Set with `queue.strategy`.

| Strategy | Behaviour | Uses |
|:--|:--|:--|
| `auto_refill` | Selects automatically and keeps `min_ahead` songs queued ahead | `min_ahead` |
| `preload` | Keeps `preload_size` songs queued at all times | `preload_size` |
| `manual_only` | Plays only what was queued by hand; never auto-selects | — |

> [!WARNING]
> Under `manual_only` the station goes silent once the queue empties — the client receives
> a `queue is empty` error rather than a track. Use it only when something else is feeding
> the queue. 🤫

## 🔀 Shuffle Strategies

Controls **which** song is chosen. Set with `shuffle.strategy`.

| Strategy | Behaviour | Good for |
|:--|:--|:--|
| `round_robin` | Plays every song once before repeating any | **Default.** Fair rotation |
| `weighted_history` | Same cycle, but weights recently played songs down using `recent_window` | Large libraries |
| `least_played` | Prefers songs not yet played this cycle, falling back to the full pool | Fresh imports |
| `random` | Pure random; may repeat immediately | Chaos 😈 |

Every strategy except `random` also refuses to play two songs by the same artist
back-to-back, as long as an alternative exists.

`round_robin` is the default because it best matches the no-repeat playback requirement.

### 🎚️ Tuning `recent_window`

Only `weighted_history` reads it. A song played *N* selections ago receives weight
`(N+1)/(window+1)`, so the most recent track is the least likely to come back and anything
outside the window keeps full weight.

| Value | Meaning |
|:--|:--|
| `0` | **Automatic** — resolves to `min(library/2, 20)` |
| `n` | Down-weight the last `n` plays; clamped so it never covers the whole library |

> [!NOTE]
> "Played" is tracked in a Bloom filter, not a history table. Bloom filters have no false
> negatives but do have false positives, so a song is very occasionally treated as already
> played and skipped within a cycle. That is the cost of having no database. 🌸
