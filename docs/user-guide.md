<div align="center">

<a href="../README.md"><img src="../frontend/src/assets/worxbend-logo.png" width="72" alt="Lofi Radio" /></a>

# 🎧 User Guide

### *Run it, feed it music, and pick a scene for your stream.*

[🏠 Home](../README.md) · [🗺️ Overview](overview.md) · **🎧 User** · [🛠️ Dev](developer-guide.md) · [🌐 API](api.md) · [🔌 WebSocket](websocket-protocol.md) · [⚙️ Config](configuration.md) · [🚀 Deploy](deployment.md)

</div>

---

## 🎵 What This App Does

It turns a folder of MP3s into a 24/7 radio station with a visualizer attached. The backend
picks the tracks; the browser page plays them and draws the visuals.

There is no "open file" button, no microphone input, and no play button. That is the point:
once it is running, it keeps running.

## 🚀 Running Locally

| Step | Do this |
|:--:|:--|
| 1️⃣ | Start the backend — see the [Deployment Guide](deployment.md) or just `go run cmd/api/main.go` |
| 2️⃣ | Start the frontend — `npm run dev` |
| 3️⃣ | Open `http://localhost:3000` |
| 4️⃣ | If the browser blocks autoplay, click or tap anywhere once 👆 |

## 📁 Adding Music

Copy `.mp3` files into the backend music folder. By default:

```text
backend/music
```

Existing files are indexed when the backend starts. New files are detected **while the
backend is running** — including files dropped into nested subfolders — and are added to the
queue automatically. No restart, no import step. 🪄

> [!TIP]
> Metadata comes from ID3 tags. Files without tags fall back to the filename as the title,
> and the duration is estimated from file size assuming 128 kbps. Tag your files if you want
> the now-playing card to look right. 🏷️

## 🎬 Choosing a Scene

There is no in-page settings panel. Each visual style is its own route, so you pick one by
opening the matching URL.

| Route | What you get | Background |
|:--|:--|:--:|
| `/` | 🌧️ Full lofi rain scene with now-playing card, progress bar and clock | Opaque |
| `/overlay` | 🪟 The same scene with the chrome removed | Opaque |
| `/logo-overlay` | ✨ Logo only | **Transparent** |
| `/spectrum` | 📊 Glowing oscilloscope waveform with an "On Air" badge | Opaque |
| `/spectrum-overlay` | 🎛️ The waveform alone | **Transparent** |

Two query parameters work on any route:

| Parameter | Effect |
|:--|:--|
| `?transparent=1` | Force a transparent background on the spectrum routes |
| `?autoplay=1` | Start audio without waiting for a click |

## 📺 Using It In OBS

1. Add a **Browser Source**. 🖥️
2. Set the URL to one of the routes above — the transparent ones composite cleanly over
   other sources.
3. Size it to your canvas.

Overlay routes try to start audio automatically, because OBS browser sources have no one to
click them. The detection looks for the `obsstudio` global that OBS injects, so it happens
without configuration.

> [!WARNING]
> Only **one** page should be producing audio. Every playing page independently asks the
> backend for songs, so two of them will fight over the queue and you will hear two
> different tracks at once. Use one audio source and add silent visual overlays alongside
> it, or mute the extras in OBS. 🔇

## 🎚️ Controlling The Queue

The admin console at `http://localhost:3000/admin.html` gives you a searchable library, the
live queue, and buttons to queue, play-now, skip and clear. 🎛️

Anything else can drive it over HTTP:

```bash
# What's in the library?
curl http://localhost:8080/v1/songs

# Search it
curl 'http://localhost:8080/v1/songs?q=rain'

# Queue something
curl -X POST http://localhost:8080/v1/queue \
  -H 'Content-Type: application/json' \
  -d '{"song_id":"SONG_ID"}'

# Play something right now, interrupting the current track
curl -X POST http://localhost:8080/v1/queue:play-next \
  -H 'Content-Type: application/json' \
  -d '{"song_id":"SONG_ID"}'

# Skip whatever is playing
curl -X POST http://localhost:8080/v1/player:skip
```

Manual queue additions may repeat a song — that is your call to make. Automatic selection
uses `round_robin` by default and plays the whole library before repeating anything.

📖 Full endpoint reference → **[Backend API](api.md)**

## 🆘 Troubleshooting

| Symptom | Likely cause |
|:--|:--|
| 🔇 Nothing plays, badge says "Live" | Autoplay is blocked — click the page once, or add `?autoplay=1` |
| 🎵 Two songs at once | More than one page is producing audio; see the warning above |
| 📭 "waiting for track…" forever | The music folder is empty, or no file matched `music.extensions` |
| 🔴 Badge says "Offline" | The backend is not running, or `VITE_BACKEND_URL` points at the wrong host |
| 🏷️ Song titles are filenames | Those files have no ID3 tags |
