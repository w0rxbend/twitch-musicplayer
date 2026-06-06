package queue

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"time"

	"github.com/google/uuid"
	"lofi-radio-backend/internal/models"
)

// SongRepository abstracts access to the song store.
type SongRepository interface {
	List(ctx context.Context) ([]*models.Song, error)
	GetByID(ctx context.Context, id string) (*models.Song, error)
	Count(ctx context.Context) (int, error)
}

// HistoryRepository abstracts access to the play-history store.
type HistoryRepository interface {
	RecordStart(ctx context.Context, entry *models.HistoryEntry) error
	MarkFinished(ctx context.Context, id string, finishedAt time.Time) error
	GetRecentSongIDs(ctx context.Context, n int) ([]string, error)
}

// QueueRepository abstracts access to the playback queue store.
type QueueRepository interface {
	Enqueue(ctx context.Context, item *models.QueueItem) error
	Dequeue(ctx context.Context) (*models.QueueItem, error)
	List(ctx context.Context) ([]*models.QueueItem, error)
	Remove(ctx context.Context, id string) error
	Clear(ctx context.Context) error
	Count(ctx context.Context) (int, error)
}

// Manager is the brain of the service — it decides which song plays next.
type Manager struct {
	songs   SongRepository
	history HistoryRepository
	queue   QueueRepository
	mu      sync.Mutex
}

// New constructs a Manager wired to the provided repository implementations.
func New(songs SongRepository, history HistoryRepository, queue QueueRepository) *Manager {
	return &Manager{
		songs:   songs,
		history: history,
		queue:   queue,
	}
}

// NextSong selects the next song to play. It first drains the manual/auto queue;
// if the queue is empty it auto-selects a song, avoiding recently played tracks
// when possible. It records the play start in history and returns both the song
// and the history entry (callers need the entry ID to later call MarkSongFinished).
func (m *Manager) NextSong(ctx context.Context) (*models.Song, *models.HistoryEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var (
		song *models.Song
		err  error
	)

	// 1. Try to dequeue from the manual/auto queue first.
	item, err := m.queue.Dequeue(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("queue dequeue: %w", err)
	}

	if item != nil {
		// Queue had an entry — fetch the full song record.
		song, err = m.songs.GetByID(ctx, item.SongID)
		if err != nil {
			return nil, nil, fmt.Errorf("get queued song %s: %w", item.SongID, err)
		}
	} else {
		// 2. Queue empty — auto-select.
		song, err = m.autoSelect(ctx)
		if err != nil {
			return nil, nil, fmt.Errorf("auto-select song: %w", err)
		}
	}

	// 3. Record the play start in history.
	entry := &models.HistoryEntry{
		ID:       uuid.New().String(),
		SongID:   song.ID,
		PlayedAt: time.Now(),
		Finished: false,
	}

	if err := m.history.RecordStart(ctx, entry); err != nil {
		return nil, nil, fmt.Errorf("record history start: %w", err)
	}

	return song, entry, nil
}

// autoSelect picks a random song while avoiding recently played tracks.
// It must be called with m.mu held.
func (m *Manager) autoSelect(ctx context.Context) (*models.Song, error) {
	allSongs, err := m.songs.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list songs: %w", err)
	}
	if len(allSongs) == 0 {
		return nil, fmt.Errorf("no songs available")
	}

	total := len(allSongs)

	// How many recent plays to exclude: min(total/2, 20).
	recentN := total / 2
	if recentN > 20 {
		recentN = 20
	}

	recentIDs, err := m.history.GetRecentSongIDs(ctx, recentN)
	if err != nil {
		return nil, fmt.Errorf("get recent song IDs: %w", err)
	}

	// Build a set for O(1) lookup.
	recentSet := make(map[string]struct{}, len(recentIDs))
	for _, id := range recentIDs {
		recentSet[id] = struct{}{}
	}

	// Filter out recently played songs.
	candidates := make([]*models.Song, 0, total)
	for _, s := range allSongs {
		if _, played := recentSet[s.ID]; !played {
			candidates = append(candidates, s)
		}
	}

	// If all songs were recently played, fall back to the full list (fresh cycle).
	if len(candidates) == 0 {
		candidates = allSongs
	}

	//nolint:gosec // Non-cryptographic random selection is intentional here.
	return candidates[rand.Intn(len(candidates))], nil
}

// AddToQueue validates that a song exists and appends it to the playback queue.
func (m *Manager) AddToQueue(ctx context.Context, songID string, source models.QueueSource) error {
	if _, err := m.songs.GetByID(ctx, songID); err != nil {
		return fmt.Errorf("song %s not found: %w", songID, err)
	}

	item := &models.QueueItem{
		ID:      uuid.New().String(),
		SongID:  songID,
		Source:  source,
		AddedAt: time.Now(),
	}

	if err := m.queue.Enqueue(ctx, item); err != nil {
		return fmt.Errorf("enqueue song %s: %w", songID, err)
	}

	return nil
}

// MarkSongFinished records that the song identified by historyID has finished playing.
func (m *Manager) MarkSongFinished(ctx context.Context, historyID string) error {
	if err := m.history.MarkFinished(ctx, historyID, time.Now()); err != nil {
		return fmt.Errorf("mark finished %s: %w", historyID, err)
	}
	return nil
}

// ListQueue returns the current contents of the playback queue.
func (m *Manager) ListQueue(ctx context.Context) ([]*models.QueueItem, error) {
	items, err := m.queue.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list queue: %w", err)
	}
	return items, nil
}

// SkipCurrent selects the next song, effectively skipping whatever is currently
// playing. Current-song tracking is the responsibility of the WebSocket layer.
func (m *Manager) SkipCurrent(ctx context.Context) (*models.Song, *models.HistoryEntry, error) {
	return m.NextSong(ctx)
}

// ClearQueue removes all pending entries from the playback queue.
func (m *Manager) ClearQueue(ctx context.Context) error {
	if err := m.queue.Clear(ctx); err != nil {
		return fmt.Errorf("clear queue: %w", err)
	}
	return nil
}
