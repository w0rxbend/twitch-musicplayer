import type { AudioEngine } from './AudioEngine';

type MessageType =
  | 'need_song'
  | 'song_finished'
  | 'heartbeat'
  | 'play_song'
  | 'queue_updated'
  | 'error'
  | 'heartbeat_ack'
  | 'state';

interface SocketMessage<T = unknown> {
  type: MessageType;
  payload?: T;
}

interface Song {
  id: string;
  title: string;
  artist?: string;
  filename: string;
}

interface PlaySongPayload {
  song: Song;
  stream_url: string;
  history_id: string;
}

interface ErrorPayload {
  message: string;
}

export interface SongInfo { title: string; artist?: string }

interface BackendPlaybackOptions {
  audio: AudioEngine;
  onStatus?: (status: string) => void;
  onSongChange?: (song: SongInfo | null) => void;
}

const reconnectBaseMs = 900;
const reconnectMaxMs = 8000;
const heartbeatMs = 25000;
const heartbeatTimeoutMs = heartbeatMs * 2.5;
const streamRetryMs = 5000;
const maxOutboxMessages = 20;
const messageTypes = new Set<MessageType>([
  'need_song',
  'song_finished',
  'heartbeat',
  'play_song',
  'queue_updated',
  'error',
  'heartbeat_ack',
  'state',
]);

export class BackendPlaybackClient {
  private audio: AudioEngine;
  private onStatus?: (status: string) => void;
  private onSongChange?: (song: SongInfo | null) => void;
  private socket: WebSocket | null = null;
  private reconnectTimer = 0;
  private heartbeatTimer = 0;
  private reconnectAttempts = 0;
  private shouldRun = false;
  private pendingPlay: PlaySongPayload | null = null;
  private current: PlaySongPayload | null = null;
  private outbox: SocketMessage[] = [];
  private awaitingSong = false;
  private lastMessageAt = 0;
  private connecting = false;
  private streamRetryTimer = 0;
  private errorRetryTimer = 0;

  constructor(options: BackendPlaybackOptions) {
    this.audio = options.audio;
    this.onStatus = options.onStatus;
    this.onSongChange = options.onSongChange;
  }

  start() {
    if (this.shouldRun) return;
    this.shouldRun = true;
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
    this.connect();
  }

  stop() {
    this.shouldRun = false;
    window.clearTimeout(this.reconnectTimer);
    window.clearInterval(this.heartbeatTimer);
    window.clearTimeout(this.streamRetryTimer);
    window.clearTimeout(this.errorRetryTimer);
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.close();
    }
    this.socket = null;
    this.connecting = false;
    this.onSongChange?.(null);
  }

  retryPendingPlay() {
    if (!this.pendingPlay) return;
    void this.play(this.pendingPlay);
  }

  private connect() {
    if (!this.shouldRun) return;
    if (this.connecting) return;
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    this.connecting = true;
    const socket = new WebSocket(getWebSocketURL());
    this.socket = socket;
    this.lastMessageAt = Date.now();

    socket.onopen = () => {
      this.connecting = false;
      this.reconnectAttempts = 0;
      this.onStatus?.('radio connected');
      this.flushOutbox();
      if (!this.current && !this.pendingPlay && !this.awaitingSong) this.requestSong();
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = window.setInterval(() => {
        if (Date.now() - this.lastMessageAt > heartbeatTimeoutMs) {
          this.reconnectNow('radio heartbeat timeout');
          return;
        }
        this.send({ type: 'heartbeat' });
      }, heartbeatMs);
    };

    socket.onmessage = event => {
      this.lastMessageAt = Date.now();
      const msg = parseMessage(event.data);
      if (!msg) return;
      void this.handleMessage(msg);
    };

    socket.onclose = () => {
      this.connecting = false;
      window.clearInterval(this.heartbeatTimer);
      if (this.socket === socket) this.socket = null;
      if (this.shouldRun) this.scheduleReconnect();
    };

    socket.onerror = () => {
      this.connecting = false;
      this.onStatus?.('radio connection error');
      this.reconnectNow();
    };
  }

  private scheduleReconnect() {
    if (!this.shouldRun) return;
    const delay = Math.min(reconnectBaseMs * 2 ** this.reconnectAttempts, reconnectMaxMs);
    this.reconnectAttempts += 1;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private async handleMessage(msg: SocketMessage) {
    switch (msg.type) {
      case 'play_song':
        if (!isPlaySongPayload(msg.payload)) return;
        this.awaitingSong = false;
        await this.play(msg.payload);
        break;
      case 'queue_updated':
        if (!this.current && !this.pendingPlay && !this.awaitingSong) this.requestSong();
        break;
      case 'error':
        if (msg.payload !== undefined && !isErrorPayload(msg.payload)) return;
        this.awaitingSong = false;
        this.onStatus?.(msg.payload?.message ?? 'radio error');
        window.clearTimeout(this.errorRetryTimer);
        this.errorRetryTimer = window.setTimeout(() => {
          if (this.shouldRun && !this.current && !this.pendingPlay && !this.awaitingSong) this.requestSong();
        }, reconnectBaseMs);
        break;
    }
  }

  private async play(payload: PlaySongPayload) {
    if (!payload?.song || !payload.stream_url || !payload.history_id) return;

    this.pendingPlay = payload;
    const songName = payload.song.title || payload.song.filename;

    try {
      await this.audio.playStream(resolveStreamURL(payload.stream_url), songName, {
        onEnded: () => this.finishCurrent(payload),
        onError: () => this.retryStream(payload),
      });
      this.current = payload;
      this.pendingPlay = null;
      window.clearTimeout(this.streamRetryTimer);
      this.onSongChange?.({ title: songName, artist: payload.song.artist });
      this.onStatus?.('playing');
    } catch {
      this.onStatus?.(this.audio.allowAutoplay ? 'audio autoplay blocked' : 'click anywhere to start audio');
    }
  }

  private finishCurrent(payload: PlaySongPayload) {
    if (this.current?.history_id !== payload.history_id) return;
    this.current = null;
    this.onSongChange?.(null);
    this.queueOrSend({
      type: 'song_finished',
      payload: {
        song_id: payload.song.id,
        history_id: payload.history_id,
      },
    });
  }

  private requestSong() {
    this.awaitingSong = true;
    this.queueOrSend({ type: 'need_song' });
  }

  private retryStream(payload: PlaySongPayload) {
    if (this.current?.history_id !== payload.history_id && this.pendingPlay?.history_id !== payload.history_id) return;
    this.pendingPlay = payload;
    this.current = null;
    this.onSongChange?.(null);
    this.onStatus?.('stream error, retrying');
    window.clearTimeout(this.streamRetryTimer);
    this.streamRetryTimer = window.setTimeout(() => {
      if (this.shouldRun) void this.play(payload);
    }, streamRetryMs);
  }

  private queueOrSend(message: SocketMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send(message);
      return;
    }

    this.outbox.push(message);
    if (this.outbox.length > maxOutboxMessages) {
      this.outbox.splice(0, this.outbox.length - maxOutboxMessages);
    }
    this.reconnectNow();
  }

  private send(message: SocketMessage) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private flushOutbox() {
    const pending = this.outbox.splice(0);
    for (const msg of pending) this.send(msg);
  }

  private reconnectNow(status?: string) {
    if (!this.shouldRun) return;
    if (status) this.onStatus?.(status);
    window.clearInterval(this.heartbeatTimer);
    window.clearTimeout(this.reconnectTimer);
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.close();
    }
    this.socket = null;
    this.connecting = false;
    this.scheduleReconnect();
  }

  private handleOnline = () => {
    this.onStatus?.('network online');
    this.reconnectNow();
  };

  private handleOffline = () => {
    this.onStatus?.('network offline');
    window.clearInterval(this.heartbeatTimer);
  };

  dispose() {
    this.stop();
    this.outbox = [];
    this.pendingPlay = null;
    this.current = null;
    this.awaitingSong = false;
    this.onSongChange?.(null);
  }
}

function parseMessage(data: unknown): SocketMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data);
    if (!isSocketMessage(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isSocketMessage(value: unknown): value is SocketMessage {
  if (!isRecord(value)) return false;
  return typeof value.type === 'string' && messageTypes.has(value.type as MessageType);
}

function isPlaySongPayload(value: unknown): value is PlaySongPayload {
  if (!isRecord(value) || !isRecord(value.song)) return false;
  return (
    typeof value.song.id === 'string' &&
    typeof value.song.title === 'string' &&
    typeof value.song.filename === 'string' &&
    (value.song.artist === undefined || typeof value.song.artist === 'string') &&
    typeof value.stream_url === 'string' &&
    typeof value.history_id === 'string'
  );
}

function isErrorPayload(value: unknown): value is ErrorPayload {
  return isRecord(value) && typeof value.message === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

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

function resolveStreamURL(url: string) {
  return new URL(url, getBackendURL()).toString();
}
