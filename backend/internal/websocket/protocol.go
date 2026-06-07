package websocket

import (
	"encoding/json"

	"lofi-radio-backend/internal/models"
)

// Client -> Server message types
const (
	MsgNeedSong     = "need_song"     // ready, send me a song
	MsgSongFinished = "song_finished" // payload: SongFinishedPayload
	MsgHeartbeat    = "heartbeat"
	MsgPeekNext     = "peek_next" // peek at next queued song for prebuffering (no dequeue)
)

// Server -> Client message types
const (
	MsgPlaySong      = "play_song"      // payload: PlaySongPayload (unicast to player)
	MsgPrebufferSong = "prebuffer_song" // response to peek_next: preload this (unicast, no dequeue)
	MsgQueueUpdated  = "queue_updated"  // payload: QueueUpdatedPayload (broadcast)
	MsgNowPlaying    = "now_playing"    // payload: NowPlayingPayload (broadcast, for management UIs)
	MsgSkipNow       = "skip_now"       // no payload; tells audio clients to skip immediately (broadcast)
	MsgError         = "error"          // payload: ErrorPayload
	MsgHeartbeatAck  = "heartbeat_ack"
	MsgState         = "state" // sent on connect: PlayerState
)

// Message is the envelope for all WebSocket messages.
type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// PlaySongPayload is sent by the server to instruct the client to play a song.
type PlaySongPayload struct {
	Song       models.Song `json:"song"`
	StreamURL  string      `json:"stream_url"`
	HistoryID  string      `json:"history_id"`
	QueueDepth int         `json:"queue_depth"`
}

// SongFinishedPayload is sent by the client when a song finishes playing.
type SongFinishedPayload struct {
	SongID    string `json:"song_id"`
	HistoryID string `json:"history_id"`
}

// QueueUpdatedPayload is broadcast when the queue changes.
type QueueUpdatedPayload struct {
	QueueDepth int    `json:"queue_depth"`
	Reason     string `json:"reason"` // "song_added" | "song_removed" | "cleared" | "new_file" | "song_started"
}

// NowPlayingPayload is broadcast whenever a new song starts playing.
// Management UIs listen for this to update their "now playing" display.
type NowPlayingPayload struct {
	Song       models.Song `json:"song"`
	QueueDepth int         `json:"queue_depth"`
}

// ErrorPayload carries an error description to the client.
type ErrorPayload struct {
	Message string `json:"message"`
}

// Encode wraps a typed payload into a Message with JSON encoding.
func Encode(msgType string, payload any) (Message, error) {
	if payload == nil {
		return Message{Type: msgType}, nil
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return Message{}, err
	}
	return Message{
		Type:    msgType,
		Payload: json.RawMessage(raw),
	}, nil
}

// DecodePayload unmarshals msg.Payload into target.
func DecodePayload(msg Message, target any) error {
	return json.Unmarshal(msg.Payload, target)
}
