package models

import "time"

// Song represents an MP3 file tracked by the service.
type Song struct {
	ID        string    `json:"id"`
	Filename  string    `json:"filename"`
	Path      string    `json:"-"`
	Title     string    `json:"title"`
	SizeBytes int64     `json:"size_bytes"`
	AddedAt   time.Time `json:"added_at"`
}

// QueueSource indicates whether a queue entry was added automatically or manually.
type QueueSource string

const (
	QueueSourceAuto   QueueSource = "auto"
	QueueSourceManual QueueSource = "manual"
)

// QueueItem is one entry in the playback queue.
type QueueItem struct {
	ID       string      `json:"id"`
	SongID   string      `json:"song_id"`
	Song     *Song       `json:"song,omitempty"`
	Position int         `json:"position"`
	Source   QueueSource `json:"source"`
	AddedAt  time.Time   `json:"added_at"`
}

// HistoryEntry records a single play event.
type HistoryEntry struct {
	ID         string     `json:"id"`
	SongID     string     `json:"song_id"`
	Song       *Song      `json:"song,omitempty"`
	PlayedAt   time.Time  `json:"played_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	Finished   bool       `json:"finished"`
}

// PlayerState is the snapshot of current playback state sent over WebSocket.
type PlayerState struct {
	CurrentSong  *Song  `json:"current_song,omitempty"`
	QueueLength  int    `json:"queue_length"`
	TotalSongs   int    `json:"total_songs"`
	HistoryCount int    `json:"history_count"`
}
