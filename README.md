<div align="center">

<img src="frontend/src/assets/worxbend-logo.png" alt="Twitch Lofi Music Player" width="140" />

# 🎧 Twitch Lofi Music Player

### *Beats to stream, chill and vibe to — served by Go, painted by WebGL.*

A self-hosted **24/7 lofi radio** for your stream. Point it at a folder of MP3s and it
becomes a station: it indexes your library, picks what plays next, crossfades between
tracks, and renders an audio-reactive visualizer you can drop straight into OBS.

<br />

[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?style=for-the-badge&logo=go&logoColor=white)](https://go.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Solid](https://img.shields.io/badge/SolidJS-1.9-2C4F7C?style=for-the-badge&logo=solid&logoColor=white)](https://www.solidjs.com)
[![Pixi](https://img.shields.io/badge/Pixi.js-8-E72264?style=for-the-badge&logo=javascript&logoColor=white)](https://pixijs.com)
[![Status](https://img.shields.io/badge/Status-Active_Development-F59E0B?style=for-the-badge)](#-roadmap)

<br />

**[⚡ Quick Start](#-quick-start) · [🎬 The Scenes](#-the-scenes) · [🧠 How It Works](#-how-it-works) · [📚 Docs](#-documentation)**

</div>

---

## ✨ Why this exists

Streaming lofi usually means one of two things: an endless YouTube tab you don't control,
or a DJ app that was never designed to be driven by a browser source. This is neither.

<table>
<tr>
<td width="33%" valign="top">

### 🗂️ Drop-in library
Throw MP3s in a folder. A filesystem watcher picks them up **while the server runs** —
no restart, no import step, no database to migrate.

</td>
<td width="33%" valign="top">

### 🧠 Actually good shuffle
Four selection strategies, plus artist-adjacency avoidance and recency weighting.
It plays your whole library before repeating anything.

</td>
<td width="33%" valign="top">

### 🎨 OBS-native visuals
Transparent browser sources, equal-power crossfades, and a WebGL scene that reacts to
real frequency data — not a canned animation.

</td>
</tr>
</table>

---

## ⚡ Quick Start

> **You'll need:** Go 1.25+, Node 20+, and a folder of MP3s. No database. No CGO. No Docker required.

**1️⃣ Start the backend** 🎛️

```bash
cd backend
cp .env.example .env
cp config.example.toml config.toml
mkdir -p music          # ← drop your MP3s in here
go run cmd/api/main.go
```

**2️⃣ Start the frontend** 🖼️

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

**3️⃣ Open it** 🚀

| What | Where |
|:--|:--|
| 🎵 Main visualizer scene | `http://localhost:3000/` |
| 🎚️ Admin console | `http://localhost:3000/admin.html` |
| 📖 Swagger API explorer | `http://localhost:8080/swagger` |

The station starts itself. The moment a browser connects, it asks the backend for a
track and starts playing. 🎶

---

## 🎬 The Scenes

Every route is a standalone page built to be a **browser source**. Add the URL to OBS,
size it, done.

| Route | Vibe | Background |
|:--|:--|:--|
| `/` | 🌧️ Full lofi rain scene, now-playing card, progress bar, clock | Opaque |
| `/overlay` | 🪟 Same scene, chrome stripped out | Opaque |
| `/logo-overlay` | ✨ Logo only, for corner placement | **Transparent** |
| `/spectrum` | 📊 Glowing oscilloscope waveform + "On Air" badge | Opaque |
| `/spectrum-overlay` | 🎛️ Bare waveform, chroma-free | **Transparent** |
| `/admin.html` | 🎚️ Library browser, live queue, skip & play-now | Opaque |

> 💡 **Pro tip:** append `?transparent=1` to force transparency on any spectrum route, and
> `?autoplay=1` to bypass the browser's user-gesture requirement. Inside OBS, autoplay is
> detected and enabled automatically. 🤫

---

## 🧠 How It Works

The backend is the DJ. The frontend is the speaker and the light show — it never decides
what plays next, it just does as it's told.

```text
        📁 your MP3 folder
                │
                ▼
        👀 fsnotify watcher ──────► 🏷️  ID3 metadata extraction
                │
                ▼
        🗃️  in-memory song index  ◄── 🌸 Bloom filter (the only thing on disk)
                │
                ▼
        🧠 queue manager  ── strategy: round_robin │ weighted_history │ least_played │ random
                │
      ┌─────────┴─────────┐
      ▼                   ▼
  🌐 HTTP /v1/*      🔌 WebSocket /ws
  (library, queue,    (play_song, now_playing,
   range streaming)    queue_updated, skip_now)
                            │
                            ▼
                  🔊 HTMLAudioElement × 2  ── equal-power crossfade
                            │
                            ▼
                  📈 Web Audio analyser
                            │
                            ▼
                  🎨 Pixi / WebGL visualizer
```

### 🌸 Wait — no database?

Correct, and on purpose. Song IDs are **UUIDv5 hashes of the file path**, so they're stable
across restarts without anything persisting them. Play history lives in a Bloom filter
that gets saved to a single file on shutdown. That's the entire persistence story.

The trade-off is honest: a Bloom filter can produce false positives, so *very* occasionally
a song is skipped in a rotation cycle. In exchange you get zero migrations, zero CGO, and a
library index that starts cold in milliseconds. For a radio station, that's a good deal. 💫

### 🎚️ The crossfade

Two audio channels, alternating. About 15 seconds before a track ends the client asks the
server to *peek* at what's next and quietly buffers it. About 3 seconds out, the real
handoff begins: the outgoing channel follows `cos(t·π/2)` while the incoming one follows
`sin(t·π/2)`. Their powers sum to a constant, so there's no volume sag in the middle — a
naive linear crossfade dips by roughly 6 dB right at the seam. 🎚️

---

## ⚙️ Configuration

Everything is set in `backend/config.toml`, and every value can be overridden by an
environment variable — container-friendly by design.

```toml
[server]
port     = 8080
base_url = "http://localhost:8080"

[music]
dir        = "~/Music/lofi"     # "~" is expanded for you
extensions = [".mp3", ".MP3"]

[bloom]
path = "./lofi-radio.bloom"     # play history lives here

[shuffle]
strategy      = "round_robin"   # random | weighted_history | round_robin | least_played
recent_window = 0               # 0 = auto: min(library/2, 20)

[queue]
strategy     = "auto_refill"    # manual_only | auto_refill | preload
min_ahead    = 1
preload_size = 3
```

<details>
<summary>🎲 <b>Which shuffle strategy should I pick?</b></summary>

<br />

| Strategy | What it does | Good for |
|:--|:--|:--|
| `round_robin` | Plays every track once before repeating any | **Default.** Fair rotation |
| `weighted_history` | Same, but biases away from recently played tracks | Large libraries |
| `least_played` | Always prefers never-played tracks | Fresh imports |
| `random` | Pure random, no diversity shaping | Chaos 😈 |

All strategies except `random` also refuse to play two songs by the same artist
back-to-back — as long as an alternative exists.

</details>

📖 Full reference → **[docs/configuration.md](docs/configuration.md)**

---

## 📚 Documentation

<table>
<tr>
<td width="50%" valign="top">

**🚦 Getting oriented**
- [🗺️ Overview](docs/overview.md)
- [🎧 User Guide](docs/user-guide.md)
- [⚙️ Configuration](docs/configuration.md)
- [🚀 Deployment Guide](docs/deployment.md)

</td>
<td width="50%" valign="top">

**🔧 Going deeper**
- [🛠️ Developer Guide](docs/developer-guide.md)
- [🤝 Contributor Guide](docs/contributor-guide.md)
- [🌐 Backend API](docs/api.md)
- [🔌 WebSocket Protocol](docs/websocket-protocol.md)
- [⚡ Performance Notes](docs/performance.md)

</td>
</tr>
</table>

---

## ✅ Verification

```bash
cd backend  && go test ./... -race    # queue strategies + hub concurrency
cd frontend && npm run build          # typecheck + production bundle
```

Both should be green before you push. The backend tests cover the shuffle guarantees
(full-cycle coverage, no back-to-back artists, recency weighting) and the WebSocket hub's
concurrency behaviour. 🧪

---

## 🗺️ Roadmap

- [ ] 💬 Twitch chat integration — song requests from viewers
- [ ] 🗳️ Viewer voting to skip
- [ ] 🖼️ Album art extraction from ID3 APIC frames
- [ ] 🎛️ More visualizer scenes
- [ ] 📻 Multiple simultaneous stations

---

## 📄 License

No license has been declared for this project yet, which means default copyright applies
and others have no explicit permission to reuse the code. If you want it to be open
source, drop a `LICENSE` file in the repo root — MIT is the usual pick for something like
this. 📝

<div align="center">
<br />
<sub>Built for streamers who'd rather ship code than babysit a playlist. ☕</sub>
</div>
