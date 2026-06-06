# WebSocket Protocol

Endpoint:

```text
ws://localhost:8080/ws
```

## Message Envelope

All messages use:

```json
{
  "type": "message_type",
  "payload": {}
}
```

## Client To Server

### `need_song`

Requests the next playable song.

```json
{"type":"need_song"}
```

### `song_finished`

Reports that the current streamed song ended.

```json
{
  "type": "song_finished",
  "payload": {
    "song_id": "song-id",
    "history_id": "history-id"
  }
}
```

### `heartbeat`

Application-level heartbeat.

```json
{"type":"heartbeat"}
```

## Server To Client

### `play_song`

Instructs the frontend to stream a song.

```json
{
  "type": "play_song",
  "payload": {
    "song": {
      "id": "song-id",
      "filename": "track.mp3",
      "title": "track",
      "artist": "",
      "album": "",
      "duration_secs": 0,
      "size_bytes": 12345,
      "added_at": "2026-06-06T12:00:00Z"
    },
    "stream_url": "http://localhost:8080/v1/songs/song-id/content",
    "history_id": "history-id",
    "queue_depth": 0
  }
}
```

### `queue_updated`

Broadcast when queue state changes.

```json
{
  "type": "queue_updated",
  "payload": {
    "queue_depth": 1,
    "reason": "song_added"
  }
}
```

Known reasons:

- `song_added`
- `song_removed`
- `skipped`
- `cleared`
- `new_file`

### `error`

```json
{
  "type": "error",
  "payload": {
    "message": "queue is empty"
  }
}
```

### `heartbeat_ack`

```json
{"type":"heartbeat_ack"}
```

### `state`

Sent after connection with a lightweight state snapshot.

```json
{
  "type": "state",
  "payload": {
    "queue_length": 0,
    "total_songs": 0,
    "history_count": 0
  }
}
```

## Frontend Contract

The frontend:

1. Connects to `/ws`.
2. Sends `need_song`.
3. Plays `play_song.payload.stream_url`.
4. Sends `song_finished` on media `ended`.
5. Waits for the next `play_song`.

The frontend does not fetch MP3 bytes into JavaScript. It assigns `stream_url` to a native media element.

## Resilience Contract

The supported frontend is a single active WebSocket playback client. It is designed to stay connected indefinitely:

- reconnects with exponential backoff up to a capped delay;
- listens for browser `online` and `offline` events;
- sends application heartbeats;
- reconnects when heartbeat acknowledgements or other messages stop arriving;
- queues important outbound control messages while disconnected;
- flushes queued messages after reconnect;
- requests a song again after reconnect when no song is active;
- retries a pending stream if browser autoplay blocked playback;
- retries stream playback after media element errors.

The server protocol remains intentionally simple because only one active playback client is supported.
