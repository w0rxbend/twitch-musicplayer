# 🚀 Deployment Guide

## Deployment Shape

Deploy the backend and frontend as separate services:

- Backend: a single static Go binary plus a mounted MP3 folder. No database service to run.
- Frontend: static assets built by Vite and served by a static host or reverse proxy.

## Backend Build

```bash
cd backend
go build -o lofi-radio-backend cmd/api/main.go
```

Run:

```bash
PORT=8080 \
BLOOM_PATH=/data/lofi-radio.bloom \
MUSIC_DIR=/data/music \
BASE_URL=https://radio.example.com \
./lofi-radio-backend
```

## Frontend Build

```bash
cd frontend
VITE_BACKEND_URL=https://radio.example.com npm run build
```

Serve `frontend/dist` from a static server.

## Reverse Proxy

A typical proxy should route:

- `/` to the frontend static app.
- `/v1/*` to the backend.
- `/ws` to the backend with WebSocket upgrade support.
- `/health` to the backend.

Example Nginx sketch:

```nginx
server {
  listen 443 ssl;
  server_name radio.example.com;

  root /srv/lofi/frontend;
  index index.html;

  location / {
    try_files $uri /index.html;
  }

  location /v1/ {
    proxy_pass http://127.0.0.1:8080;
  }

  location /health {
    proxy_pass http://127.0.0.1:8080;
  }

  location /ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```

## Persistent Storage

Persist:

- Bloom-filter history path from `BLOOM_PATH` (defaults to `./lofi-radio.bloom`). Mount it on a persistent volume so play history survives restarts.
- Music folder from `MUSIC_DIR`.

Do not place these inside ephemeral container layers.

## Security Notes

The current backend CORS and WebSocket origin handling are permissive for local development. For production:

- Restrict allowed origins.
- Restrict WebSocket origins.
- Add authentication for queue control endpoints if exposed publicly.
- Consider read-only public song streaming and authenticated queue mutation.

## Operational Notes

- The backend scans the music folder on startup.
- New files are added on create events.
- File deletion is not currently reconciled.
- Large file copies should be staged outside the watched folder, then moved into place when complete.
