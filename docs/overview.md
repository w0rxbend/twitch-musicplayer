<div align="center">

<a href="../README.md"><img src="../frontend/src/assets/worxbend-logo.png" width="72" alt="Lofi Radio" /></a>

# 🗺️ Overview

### *The ten-thousand-foot view: two services, one radio station.*

[🏠 Home](../README.md) · **🗺️ Overview** · [🎧 User](user-guide.md) · [🛠️ Dev](developer-guide.md) · [🌐 API](api.md) · [🔌 WebSocket](websocket-protocol.md) · [⚙️ Config](configuration.md) · [🚀 Deploy](deployment.md)

</div>

---

Twitch Lofi Music Player is a **two-service application**. One decides what plays; the
other makes it audible and pretty.

<table>
<tr>
<td width="50%" valign="top">

### 🎛️ `backend/` — the DJ
Go HTTP + WebSocket service. Owns the music library, the queue, and every decision about
what plays next.

</td>
<td width="50%" valign="top">

### 🖼️ `frontend/` — the booth
Solid + Pixi/WebGL. Plays what it is told to play and renders the visuals.

</td>
</tr>
</table>

> [!IMPORTANT]
> The frontend supports **backend playback only**. There are no controls for loading local
> files, using a microphone, or starting playback by hand. The backend owns the library and
> sends playback instructions over WebSocket. This is deliberate: a stream should not depend
> on someone clicking something.

## 🏗️ Architecture

```text
        📁 MP3 folder
              │
              ▼
        👀 fsnotify watcher ──────► 🏷️  ID3 metadata extraction
              │
              ▼
        🗃️  in-memory song index  ◄── 🌸 Bloom filter play history
              │
              ▼
        🧠 queue manager
              │
    ┌─────────┴─────────┐
    ▼                   ▼
🌐 HTTP /v1/*      🔌 WebSocket /ws
                          │
                          ▼
                🔊 HTMLAudioElement
                          │
                          ▼
                📈 Web Audio analyser
                          │
                          ▼
                🎨 Pixi / WebGL visualizer
```

## 🎛️ Backend Responsibilities

| | Responsibility |
|:--|:--|
| 📂 | Scan the configured music folder at startup |
| 👀 | Watch for newly created MP3 files, including in nested subfolders |
| 🏷️ | Extract metadata from ID3 tags where available |
| 🗃️ | Hold songs and queue entries in an in-memory index — **there is no database** |
| 🌸 | Persist play history in a Bloom filter file, written on shutdown and reloaded at startup |
| 🔑 | Derive song IDs as UUIDv5 hashes of the file path, so they stay stable across restarts |
| 📡 | Serve MP3 files over HTTP with Range support, so seeking works |
| 🌐 | Provide resource-oriented HTTP APIs under `/v1` |
| 🔌 | Provide WebSocket playback messages under `/ws` |
| 🔀 | Avoid repeats by default through `round_robin` selection |

## 🖼️ Frontend Responsibilities

| | Responsibility |
|:--|:--|
| 🔌 | Connect to the backend WebSocket endpoint |
| 🙋 | Request a song with `need_song` |
| 🔊 | Play `play_song.payload.stream_url` through `HTMLAudioElement` |
| ✅ | Report `song_finished` when playback ends |
| 🎨 | Render audio-reactive visuals through Pixi/WebGL |
| 🪟 | Provide transparent overlay routes at `/logo-overlay` and `/spectrum-overlay` |

## 🔌 WebSocket Client Model

The supported deployment model is **one active WebSocket playback client**.

That client is expected to be long-lived and resilient. It reconnects automatically with
exponential backoff, sends heartbeats, detects stale sockets by tracking time since the
last message, retries stream playback failures, and resumes requesting songs after a
reconnect. Messages that cannot be sent while the socket is down are queued in a bounded
outbox and flushed on reconnect.

> [!NOTE]
> Extra clients may connect — the admin console does, and so does every overlay you add in
> OBS. They all receive the broadcast messages (`now_playing`, `queue_updated`, `skip_now`).
> What they must not do is each request their own songs, since every `need_song` advances
> the shared queue.
