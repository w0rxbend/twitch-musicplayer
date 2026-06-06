# Backend API

Base URL:

```text
http://localhost:8080
```

## Health

```http
GET /health
```

Returns `200` when the HTTP process is alive.

## Songs

```http
GET /v1/songs
```

Response:

```json
{
  "songs": [],
  "total": 0
}
```

```http
GET /v1/songs/{id}
```

Returns a song resource.

```http
GET /v1/songs/{id}/content
GET /v1/songs/{id}:stream
```

Streams MP3 content. The backend uses `http.ServeFile`, so range requests are supported by the standard library.

## Queue

```http
GET /v1/queue
```

Returns pending queue items.

```http
POST /v1/queue
Content-Type: application/json

{"song_id":"SONG_ID"}
```

Adds a song manually. Manual additions may repeat the same song.

```http
DELETE /v1/queue/{queue_item_id}
```

Removes a queued item.

```http
POST /v1/queue:skip
```

Advances to the next song and records a new history start.

```http
POST /v1/queue:clear
```

Clears all pending queue entries.

Queue mutations broadcast `queue_updated` to connected WebSocket clients.

## History

```http
GET /v1/history
GET /v1/history?limit=25
```

Returns play history. Default limit is `50`; maximum limit is `200`.

## Player

```http
GET /v1/player
```

Returns current aggregate counts:

```json
{
  "queue_length": 0,
  "total_songs": 0,
  "history_count": 0
}
```

Current limitation: this endpoint does not yet expose one authoritative current song.
