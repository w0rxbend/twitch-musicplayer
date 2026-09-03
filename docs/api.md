# 🌐 Backend API

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

Advances to the next song and returns it as `{"song": {...}}`.

```http
POST /v1/queue:clear
```

Clears all pending queue entries.

```http
POST /v1/queue:play-next
Content-Type: application/json

{"song_id":"SONG_ID"}
```

Inserts a song at the front of the queue and broadcasts `skip_now`, so connected audio
clients abandon the current track and pull this one immediately.

Queue mutations broadcast `queue_updated` to connected WebSocket clients.

## Player

```http
GET /v1/player
```

Returns the authoritative playback snapshot:

```json
{
  "current_song": { "id": "...", "title": "...", "artist": "..." },
  "queue_length": 0,
  "total_songs": 0
}
```

`current_song` is omitted while nothing is playing.

```http
POST /v1/player:skip
```

Broadcasts `skip_now` to every connected audio client. No server-side queue manipulation
happens here; the usual `need_song` flow performs the dequeue.

## History

There is no history endpoint. Play history is not stored as records — it is kept in a
Bloom filter used only to decide what has already been played this cycle. The `history_id`
in WebSocket payloads is a per-playback correlation ID, not a stored entity.
