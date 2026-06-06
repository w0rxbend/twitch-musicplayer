# Twitch Lofi Music Player

Monorepo for a backend-controlled lofi music visualizer.

The Go backend indexes MP3 files, exposes resource-oriented HTTP APIs, streams audio files efficiently, tracks playback history in SQLite, and coordinates playback over WebSockets. The frontend is backend-only: it connects to the backend WebSocket protocol, streams the provided song URLs through a native `HTMLAudioElement`, and renders the visualizer through Pixi/WebGL.

## Quick Start

```bash
cd backend
cp .env.example .env
cp config.example.toml config.toml
mkdir -p music
go run cmd/api/main.go
```

In another terminal:

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`. Press `T` to toggle the tweaks panel.

## Documentation

- [Overview](docs/overview.md)
- [User Guide](docs/user-guide.md)
- [Developer Guide](docs/developer-guide.md)
- [Contributor Guide](docs/contributor-guide.md)
- [Deployment Guide](docs/deployment.md)
- [Backend API](docs/api.md)
- [WebSocket Protocol](docs/websocket-protocol.md)
- [Configuration](docs/configuration.md)
- [Requirement Review](docs/requirement-review.md)
- [Performance Notes](docs/performance.md)

## Verification

```bash
cd backend && go test ./...
cd frontend && npm run build
```
