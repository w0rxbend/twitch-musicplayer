# Configuration

## Backend TOML

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

## Backend Environment

Example: `backend/.env.example`.

```bash
PORT=8080
APP_ENV=local
BLUEPRINT_DB_URL=./lofi-radio.db
MUSIC_DIR=./music
BASE_URL=http://localhost:8080
```

Environment variables override TOML values:

- `PORT`
- `BLUEPRINT_DB_URL`
- `MUSIC_DIR`
- `BASE_URL`

## Frontend Environment

Example: `frontend/.env.example`.

```bash
VITE_BACKEND_URL=http://localhost:8080
```

`VITE_BACKEND_URL` is used to derive:

- WebSocket URL: `ws://.../ws` or `wss://.../ws`.
- Relative stream URL resolution.

## Queue Strategies

- `manual_only`: only manually queued songs play.
- `auto_refill`: selects automatically and keeps `min_ahead` songs queued ahead.
- `preload`: keeps a configured number of songs queued.

## Shuffle Strategies

- `round_robin`: avoids repeating any song until all known songs have played.
- `least_played`: prefers songs with the fewest history entries.
- `weighted_history`: excludes recent songs according to `recent_window`.
- `random`: pure random, may repeat immediately.

Default strategy is `round_robin` because it best matches the no-repeat automatic playback requirement.
