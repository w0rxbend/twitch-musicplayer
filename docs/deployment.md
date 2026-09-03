<div align="center">

<a href="../README.md"><img src="../frontend/src/assets/worxbend-logo.png" width="72" alt="Lofi Radio" /></a>

# 🚀 Deployment Guide

### *Getting the station on the air, and keeping it there.*

[🏠 Home](../README.md) · [🗺️ Overview](overview.md) · [🎧 User](user-guide.md) · [🛠️ Dev](developer-guide.md) · [🌐 API](api.md) · [🔌 WebSocket](websocket-protocol.md) · [⚙️ Config](configuration.md) · **🚀 Deploy**

</div>

---

## 🏗️ Deployment Shape

Two services, either way you run them:

- **Backend** — a single static Go binary plus a mounted MP3 folder. No database service.
- **Frontend** — static assets built by Vite, served by nginx or any static host.

The fastest path is Docker Compose. Building from source is documented further down.

---

## 🐳 Docker Compose

Three compose files, for three different jobs.

| File | Job | Images |
|:--|:--|:--|
| `docker-compose.yml` | Run it locally | Built from the Dockerfiles in this repo |
| `docker-compose.build.yml` | Build and publish | Tagged for Docker Hub |
| `docker-compose.hub.yml` | Run it anywhere | Pulled from Docker Hub |

### 🚀 Run locally

```bash
cp .env.example .env          # optional: set MUSIC_DIR and ports
docker compose up -d --build
```

| | URL |
|:--|:--|
| 🎵 Visualizer | http://localhost:3000 |
| 🎚️ Admin console | http://localhost:3000/admin |
| 📖 Swagger | http://localhost:8080/swagger |

Stop with `docker compose down`. Add `-v` to also discard the play history.

### 📦 Run from Docker Hub

No source checkout needed — one file is enough:

```bash
curl -O https://raw.githubusercontent.com/w0rxbend/twitch-musicplayer/main/docker-compose.hub.yml
MUSIC_DIR=~/Music docker compose -f docker-compose.hub.yml up -d
```

### 🏗️ Build and publish

```bash
docker login
IMAGE_TAG=0.1.0 docker compose -f docker-compose.build.yml build
IMAGE_TAG=0.1.0 docker compose -f docker-compose.build.yml push
```

That builds for the current machine's architecture. For images that also run on
Apple Silicon and Raspberry Pi, register the emulators once and use Buildx Bake:

```bash
docker run --privileged --rm tonistiigi/binfmt --install all   # once
docker buildx create --use --name lofi                          # once
IMAGE_TAG=0.1.0 docker buildx bake -f docker-compose.build.yml \
    --set '*.platform=linux/amd64,linux/arm64' --push
```

> [!NOTE]
> The platform list is not baked into the compose file on purpose. Without the
> emulators installed, a plain `docker compose build` would fail with
> `exec format error` on the foreign architecture.

### ⚙️ Compose settings

Every value has a working default, so `docker compose up -d --build` runs with no `.env`
at all.

| Variable | Default | What it does |
|:--|:--|:--|
| `MUSIC_DIR` | `./music` | Host folder mounted read-only at `/music` |
| `FRONTEND_PORT` | `3000` | Host port for the visualizer |
| `BACKEND_PORT` | `8080` | Host port for the API and WebSocket |
| `BASE_URL` | `http://localhost:8080` | Address the backend puts into stream URLs |
| `BACKEND_URL` | *(empty)* | Address the page looks for the backend at |
| `VITE_BACKEND_URL` | *(empty)* | Compiles a backend URL into the bundle |
| `VITE_AUTO_START_AUDIO` | `false` | Start audio without a click |
| `DOCKERHUB_NAMESPACE` | `worxbend` | Docker Hub account for build/hub files |
| `IMAGE_TAG` | `latest` | Tag for build/hub files |

> [!IMPORTANT]
> `BASE_URL` and `BACKEND_URL` must be reachable **from the browser**, not from inside the
> Compose network. Using `http://backend:8080` looks tidy and does not work: the browser
> cannot resolve a Compose service name. If you move `BACKEND_PORT`, change `BASE_URL` to
> match, or the audio stream URLs will point at the wrong port.

### 🌍 Deploying to a real host

The published frontend image carries **no** backend URL. It resolves one at container
start, in this order:

1. `BACKEND_URL`, written into `/config.js` by the image's entrypoint.
2. `VITE_BACKEND_URL`, if the image was built with one.
3. The host that served the page, on port 8080.

Step 3 is why the defaults work unchanged on a remote server: browse to
`http://myserver:3000` and the page talks to `http://myserver:8080`. Set `BACKEND_URL`
only when the backend is somewhere else, or behind TLS:

```bash
BASE_URL=https://radio.example.com \
BACKEND_URL=https://radio.example.com \
docker compose -f docker-compose.hub.yml up -d
```

Changing it needs only a restart, never a rebuild. 🎉

### 💾 What persists

The `bloom-data` named volume holds the play history, so the rotation survives a restart.
Your music is mounted read-only and is never written to. Delete the volume with
`docker compose down -v` to start the rotation fresh.

---

## 🎛️ Backend Build

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

## 🖼️ Frontend Build

```bash
cd frontend
VITE_BACKEND_URL=https://radio.example.com npm run build
```

Serve `frontend/dist` from a static server.

## 🔀 Reverse Proxy

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

## 💾 Persistent Storage

Persist:

- Bloom-filter history path from `BLOOM_PATH` (defaults to `./lofi-radio.bloom`). Mount it on a persistent volume so play history survives restarts.
- Music folder from `MUSIC_DIR`.

Do not place these inside ephemeral container layers.

## 🔐 Security Notes

The current backend CORS and WebSocket origin handling are permissive for local development. For production:

- Restrict allowed origins.
- Restrict WebSocket origins.
- Add authentication for queue control endpoints if exposed publicly.
- Consider read-only public song streaming and authenticated queue mutation.

## 🛠️ Operational Notes

- The backend scans the music folder on startup.
- New files are added on create events.
- File deletion is not currently reconciled.
- Large file copies should be staged outside the watched folder, then moved into place when complete.
