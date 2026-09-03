<div align="center">

<a href="../README.md"><img src="../frontend/src/assets/worxbend-logo.png" width="96" alt="Lofi Radio" /></a>

# 📚 Documentation

### *Everything about the station, in one place.*

[🏠 Back to the project README](../README.md)

</div>

---

## 🧭 Start here

| | Guide | Read it when |
|:--:|:--|:--|
| 🗺️ | **[Overview](overview.md)** | You want the shape of the system before touching anything |
| 🎧 | **[User Guide](user-guide.md)** | You want it running and pointed at your music |
| ⚙️ | **[Configuration](configuration.md)** | You want to change how it picks songs, or where things live |
| 🚀 | **[Deployment Guide](deployment.md)** | You are putting it somewhere other than your laptop |

## 🔧 Building on it

| | Guide | Read it when |
|:--:|:--|:--|
| 🛠️ | **[Developer Guide](developer-guide.md)** | You are changing the code and need the map |
| 🌐 | **[Backend API](api.md)** | You are driving the queue from another tool |
| 🔌 | **[WebSocket Protocol](websocket-protocol.md)** | You are writing your own playback client |
| ⚡ | **[Performance Notes](performance.md)** | Frames are dropping and you want to know why |
| 🤝 | **[Contributor Guide](contributor-guide.md)** | You are opening a pull request |
| 📋 | **[Requirement Review](requirement-review.md)** | You want to know what shipped versus what was asked for |

---

## ⚡ The 30-second version

```text
📁 MP3 folder → 👀 watcher → 🗃️ in-memory index → 🧠 queue manager
                                                        │
                                          🌐 HTTP  ─────┴───── 🔌 WebSocket
                                                                    │
                                                          🔊 audio → 🎨 visuals
```

The backend decides what plays. The browser page plays it and draws the picture. There is
**no database** — song IDs are hashes of the file path, and play history lives in a single
Bloom filter file. 🌸

<div align="center">
<br />
<sub>Something here contradict the code? That's a bug — please open an issue. 🐛</sub>
</div>
