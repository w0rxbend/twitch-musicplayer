import {
  createSignal,
  createEffect,
  onMount,
  onCleanup,
  For,
  Show,
} from 'solid-js';

// ── Types ──────────────────────────────────────────────────────────────────

interface Song {
  id: string;
  filename: string;
  title: string;
  artist: string;
  album: string;
  duration_secs: number;
  size_bytes: number;
}

interface QueueItem {
  id: string;
  song_id: string;
  song?: Song;
  position: number;
  source: 'auto' | 'manual';
  added_at: string;
}

interface WsMessage {
  type: string;
  payload?: unknown;
}

// ── Backend URL helpers ────────────────────────────────────────────────────

function getBackendURL() {
  const configured = import.meta.env.VITE_BACKEND_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');
  return `${window.location.protocol}//${window.location.hostname}:8080`;
}

function getWebSocketURL() {
  const base = new URL(getBackendURL());
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = '/ws';
  base.search = '';
  return base.toString();
}

// ── Utility ────────────────────────────────────────────────────────────────

function formatDuration(secs: number): string {
  if (!secs || secs <= 0) return '--:--';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function songLabel(song: Song): string {
  return song.artist ? `${song.artist} — ${song.title}` : song.title || song.filename;
}

// ── Admin App ──────────────────────────────────────────────────────────────

export function AdminApp() {
  const backendURL = getBackendURL();

  const [songs, setSongs] = createSignal<Song[]>([]);
  const [queue, setQueue] = createSignal<QueueItem[]>([]);
  const [currentSong, setCurrentSong] = createSignal<Song | null>(null);
  const [connected, setConnected] = createSignal(false);
  const [notification, setNotification] = createSignal('');
  let notifTimer = 0;

  // ── REST helpers ───────────────────────────────────────────────────────

  async function fetchSongs(q = '') {
    try {
      const url = q
        ? `${backendURL}/v1/songs?q=${encodeURIComponent(q)}`
        : `${backendURL}/v1/songs`;
      const res = await fetch(url);
      const data = await res.json();
      setSongs(data.songs ?? []);
    } catch { /* network error, keep stale data */ }
  }

  async function fetchQueue() {
    try {
      const res = await fetch(`${backendURL}/v1/queue`);
      const data = await res.json();
      setQueue(data.items ?? []);
    } catch { /* keep stale */ }
  }

  async function fetchPlayerState() {
    try {
      const res = await fetch(`${backendURL}/v1/player`);
      const data = await res.json();
      setCurrentSong(data.current_song ?? null);
    } catch { /* keep stale */ }
  }

  // ── Actions ────────────────────────────────────────────────────────────

  async function addToQueue(songId: string, title: string) {
    const res = await fetch(`${backendURL}/v1/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song_id: songId }),
    });
    if (res.ok) {
      await fetchQueue();
      showNotification(`Queued: ${title}`);
    }
  }

  async function playNow(songId: string, title: string) {
    const res = await fetch(`${backendURL}/v1/queue:play-next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song_id: songId }),
    });
    if (res.ok) {
      await fetchQueue();
      showNotification(`Playing: ${title}`);
    }
  }

  async function removeFromQueue(itemId: string) {
    await fetch(`${backendURL}/v1/queue/${itemId}`, { method: 'DELETE' });
    await fetchQueue();
  }

  async function skipCurrent() {
    // Broadcasts skip_now via WebSocket so the main scene / overlay immediately
    // abandons the current track and pulls the next one from the queue.
    await fetch(`${backendURL}/v1/player:skip`, { method: 'POST' });
    await Promise.all([fetchQueue(), fetchPlayerState()]);
  }

  async function clearQueue() {
    await fetch(`${backendURL}/v1/queue:clear`, { method: 'POST' });
    await fetchQueue();
  }

  function showNotification(msg: string) {
    window.clearTimeout(notifTimer);
    setNotification(msg);
    notifTimer = window.setTimeout(() => setNotification(''), 2500);
  }

  // ── WebSocket (live updates) ───────────────────────────────────────────

  let socket: WebSocket | null = null;
  let heartbeatInterval = 0;
  let reconnectTimeout = 0;

  function connectWS() {
    if (socket && socket.readyState <= WebSocket.OPEN) return;

    socket = new WebSocket(getWebSocketURL());

    socket.onopen = () => {
      setConnected(true);
      window.clearInterval(heartbeatInterval);
      heartbeatInterval = window.setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'heartbeat' }));
        }
      }, 25000);
    };

    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as WsMessage;
        handleWSMessage(msg);
      } catch { /* malformed message */ }
    };

    socket.onclose = () => {
      setConnected(false);
      window.clearInterval(heartbeatInterval);
      window.clearTimeout(reconnectTimeout);
      reconnectTimeout = window.setTimeout(connectWS, 3000);
    };

    socket.onerror = () => socket?.close();
  }

  function handleWSMessage(msg: WsMessage) {
    switch (msg.type) {
      case 'queue_updated':
        void fetchQueue();
        break;
      case 'now_playing': {
        const p = msg.payload as { song?: Song; queue_depth?: number } | undefined;
        if (p?.song) {
          setCurrentSong(p.song);
          void fetchQueue();
        }
        break;
      }
      case 'state': {
        const p = msg.payload as { current_song?: Song } | undefined;
        if (p?.current_song) setCurrentSong(p.current_song);
        void fetchQueue();
        break;
      }
    }
  }

  // ── Search with debounce ───────────────────────────────────────────────

  const [searchQuery, setSearchQuery] = createSignal('');
  let searchTimer = 0;

  createEffect(() => {
    const q = searchQuery();
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void fetchSongs(q), 280);
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  onMount(async () => {
    await Promise.all([fetchSongs(), fetchQueue(), fetchPlayerState()]);
    connectWS();
  });

  onCleanup(() => {
    window.clearInterval(heartbeatInterval);
    window.clearTimeout(reconnectTimeout);
    window.clearTimeout(notifTimer);
    socket?.close();
  });

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div class="admin-shell">

      {/* Header */}
      <header class="admin-header">
        <h1>Lofi Radio — Admin</h1>
        <span class="status-label">
          <span class={`status-dot ${connected() ? 'connected' : ''}`} />
          {connected() ? 'Connected' : 'Disconnected'}
        </span>
      </header>

      {/* Now playing bar */}
      <div class="now-playing-bar">
        <span class="now-playing-label">Now Playing</span>
        <div class="now-playing-info">
          <Show
            when={currentSong()}
            fallback={<span class="now-playing-empty">Nothing playing</span>}
          >
            {(song) => (
              <>
                <div class="now-playing-title">{song().title || song().filename}</div>
                <div class="now-playing-artist">{song().artist || 'Unknown artist'}</div>
              </>
            )}
          </Show>
        </div>
        <button class="btn btn-warning" onClick={skipCurrent}>Skip</button>
        <button class="btn btn-ghost" onClick={clearQueue}>Clear Queue</button>
      </div>

      {/* Main two-column layout */}
      <div class="admin-main">

        {/* Left: Song browser */}
        <div class="song-panel">
          <div class="panel-header">
            <span class="panel-title">Library</span>
            <input
              class="search-box"
              type="search"
              placeholder="Search title, artist, album…"
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
            />
            <span class="song-count">{songs().length} songs</span>
          </div>
          <div class="song-list">
            <For each={songs()} fallback={
              <div class="queue-empty">No songs found</div>
            }>
              {(song) => (
                <div class="song-item">
                  <div class="song-info">
                    <div class="song-title">{song.title || song.filename}</div>
                    <div class="song-meta">
                      {[song.artist, song.album].filter(Boolean).join(' · ') || 'Unknown'}
                    </div>
                  </div>
                  <span class="song-duration">{formatDuration(song.duration_secs)}</span>
                  <div class="song-actions">
                    <button
                      class="btn btn-ghost btn-icon"
                      title="Add to queue"
                      onClick={() => addToQueue(song.id, songLabel(song))}
                    >+</button>
                    <button
                      class="btn btn-primary btn-icon"
                      title="Play now"
                      onClick={() => playNow(song.id, songLabel(song))}
                    >▶</button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>

        {/* Right: Queue */}
        <div class="queue-panel">
          <div class="panel-header">
            <span class="panel-title">Queue</span>
            <span class="song-count">{queue().length} items</span>
            <div class="queue-actions">
              <button class="btn btn-ghost" style="font-size:11px;padding:4px 8px" onClick={skipCurrent}>
                Skip
              </button>
              <button class="btn btn-danger" style="font-size:11px;padding:4px 8px" onClick={clearQueue}>
                Clear
              </button>
            </div>
          </div>
          <div class="queue-list">
            <Show
              when={queue().length > 0}
              fallback={<div class="queue-empty">Queue is empty</div>}
            >
              <For each={queue()}>
                {(item, idx) => (
                  <div class="queue-item">
                    <span class="queue-pos">{idx() + 1}</span>
                    <span class={`queue-source ${item.source}`} title={item.source} />
                    <div class="queue-info">
                      <div class="queue-title">
                        {item.song?.title || item.song?.filename || item.song_id}
                      </div>
                      <div class="queue-artist">
                        {item.song?.artist || 'Unknown artist'}
                      </div>
                    </div>
                    <button
                      class="btn btn-danger btn-icon"
                      title="Remove from queue"
                      onClick={() => removeFromQueue(item.id)}
                    >✕</button>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>

      </div>

      {/* Toast notification */}
      <Show when={notification()}>
        <div class="notification">{notification()}</div>
      </Show>

    </div>
  );
}
