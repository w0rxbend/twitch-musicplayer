# 🗺️ Overview

Twitch Lofi Music Player is a two-service application:

- `backend/`: Go HTTP/WebSocket service.
- `frontend/`: Solid + Pixi/WebGL visualizer.

The frontend supports backend playback only. There are no visible controls for loading local audio files, using a microphone, or manually starting playback. The backend owns the music library and sends playback instructions over WebSockets.

## 🏗️ Architecture

```text
MP3 folder
   |
   v
backend watcher -> in-memory song index
   |
   v
queue manager + history
   |
   +--> HTTP API /v1/*
   |
   +--> WebSocket /ws -> frontend playback client
                         |
                         v
                  HTMLAudioElement stream
                         |
                         v
                  Web Audio analyser -> Pixi/WebGL visualizer
```

## 🎛️ Backend Responsibilities

- Scan configured music folder at startup.
- Watch for newly created MP3 files.
- Extract basic metadata from ID3 tags where available.
- Hold songs and queue entries in an in-memory index; there is no database.
- Persist play history in a Bloom filter file, written on shutdown and reloaded at startup.
- Derive song IDs as UUIDv5 hashes of the file path, so they stay stable across restarts.
- Serve MP3 files through HTTP with range support.
- Provide resource-oriented HTTP APIs under `/v1`.
- Provide WebSocket playback messages under `/ws`.
- Avoid automatic repeats by default through `round_robin` selection.

## 🖼️ Frontend Responsibilities

- Connect to the backend WebSocket endpoint.
- Request a song with `need_song`.
- Play `play_song.payload.stream_url` through `HTMLAudioElement`.
- Report `song_finished` when playback ends.
- Render audio-reactive visuals through Pixi/WebGL.
- Provide transparent overlay routes at `/logo-overlay` and `/spectrum-overlay`.

## 🔌 WebSocket Client Model

The supported deployment model is one active WebSocket playback client. That client is expected to be long-lived and resilient: it reconnects automatically, sends heartbeats, detects stale sockets, retries stream playback failures, and resumes requesting songs after reconnect.
