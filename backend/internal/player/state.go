package player

import (
	"sync"

	"lofi-radio-backend/internal/models"
)

// StateTracker holds the currently playing song, updated by the WebSocket layer
// when a new song starts and read by the HTTP player endpoint.
type StateTracker struct {
	mu          sync.RWMutex
	currentSong *models.Song
}

func NewStateTracker() *StateTracker { return &StateTracker{} }

func (t *StateTracker) SetCurrentSong(song *models.Song) {
	t.mu.Lock()
	t.currentSong = song
	t.mu.Unlock()
}

func (t *StateTracker) GetCurrentSong() *models.Song {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.currentSong
}
