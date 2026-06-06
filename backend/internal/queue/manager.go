package queue

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"time"

	"github.com/google/uuid"
	"lofi-radio-backend/internal/models"
)

// ErrQueueEmpty is returned by NextSong when using manual_only strategy and no songs are queued.
var ErrQueueEmpty = errors.New("queue is empty")

// ErrSongNotFound is returned by AddToQueue when the requested song does not exist.
var ErrSongNotFound = errors.New("song not found")

// ShuffleStrategy controls how songs are selected for auto-play.
type ShuffleStrategy string

const (
	ShuffleRandom          ShuffleStrategy = "random"
	ShuffleWeightedHistory ShuffleStrategy = "weighted_history"
	ShuffleRoundRobin      ShuffleStrategy = "round_robin"
	ShuffleLeastPlayed     ShuffleStrategy = "least_played"
)

// FillStrategy controls when and how the queue is auto-populated.
type FillStrategy string

const (
	FillManualOnly FillStrategy = "manual_only"
	FillAutoRefill FillStrategy = "auto_refill"
	FillPreload    FillStrategy = "preload"
)

// ShuffleConfig holds per-strategy shuffle parameters.
type ShuffleConfig struct {
	Strategy     ShuffleStrategy
	RecentWindow int // 0 = auto
}

// FillConfig holds per-strategy queue-fill parameters.
type FillConfig struct {
	Strategy    FillStrategy
	MinAhead    int
	PreloadSize int
}

// ManagerConfig bundles all tunable parameters for the Manager.
type ManagerConfig struct {
	Shuffle ShuffleConfig
	Fill    FillConfig
}

func defaultConfig() ManagerConfig {
	return ManagerConfig{
		Shuffle: ShuffleConfig{Strategy: ShuffleRoundRobin, RecentWindow: 0},
		Fill:    FillConfig{Strategy: FillAutoRefill, MinAhead: 1, PreloadSize: 3},
	}
}

// --- local repository interfaces (avoids circular import) ---

type SongRepository interface {
	List(ctx context.Context) ([]*models.Song, error)
	GetByID(ctx context.Context, id string) (*models.Song, error)
	Count(ctx context.Context) (int, error)
}

type HistoryRepository interface {
	RecordStart(ctx context.Context, entry *models.HistoryEntry) error
	MarkFinished(ctx context.Context, id string, finishedAt time.Time) error
	GetRecentSongIDs(ctx context.Context, n int) ([]string, error)
	GetSongPlayCounts(ctx context.Context) (map[string]int, error)
}

type QueueRepository interface {
	Enqueue(ctx context.Context, item *models.QueueItem) error
	Dequeue(ctx context.Context) (*models.QueueItem, error)
	List(ctx context.Context) ([]*models.QueueItem, error)
	Remove(ctx context.Context, id string) error
	Clear(ctx context.Context) error
	Count(ctx context.Context) (int, error)
}

// Manager is the brain of the service — decides which song plays next.
type Manager struct {
	songs   SongRepository
	history HistoryRepository
	queue   QueueRepository
	cfg     ManagerConfig
	mu      sync.Mutex
}

// New constructs a Manager. Pass a zero-value ManagerConfig to use defaults.
func New(songs SongRepository, history HistoryRepository, queue QueueRepository, cfg ManagerConfig) *Manager {
	if cfg.Shuffle.Strategy == "" {
		cfg = defaultConfig()
	}
	return &Manager{songs: songs, history: history, queue: queue, cfg: cfg}
}

// NextSong selects the next song according to the configured fill and shuffle strategies.
// It records a play-start in history and returns the song + history entry.
func (m *Manager) NextSong(ctx context.Context) (*models.Song, *models.HistoryEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var song *models.Song

	// manual_only: only dequeue; never auto-select.
	if m.cfg.Fill.Strategy == FillManualOnly {
		item, err := m.queue.Dequeue(ctx)
		if errors.Is(err, sql.ErrNoRows) || item == nil {
			return nil, nil, ErrQueueEmpty
		}
		if err != nil {
			return nil, nil, fmt.Errorf("dequeue: %w", err)
		}
		s, err := m.songs.GetByID(ctx, item.SongID)
		if err != nil {
			return nil, nil, fmt.Errorf("get queued song: %w", err)
		}
		song = s
	} else {
		// Try the queue first; auto-select if empty.
		item, err := m.queue.Dequeue(ctx)
		if errors.Is(err, sql.ErrNoRows) || item == nil {
			var selErr error
			song, selErr = m.autoSelect(ctx)
			if selErr != nil {
				return nil, nil, fmt.Errorf("auto-select: %w", selErr)
			}
		} else if err != nil {
			return nil, nil, fmt.Errorf("dequeue: %w", err)
		} else {
			var getErr error
			song, getErr = m.songs.GetByID(ctx, item.SongID)
			if getErr != nil {
				return nil, nil, fmt.Errorf("get queued song: %w", getErr)
			}
		}

		switch m.cfg.Fill.Strategy {
		case FillPreload:
			if err := m.fillQueue(ctx, m.cfg.Fill.PreloadSize, song.ID); err != nil {
				return nil, nil, fmt.Errorf("preload queue: %w", err)
			}
		case FillAutoRefill:
			if err := m.fillQueue(ctx, m.cfg.Fill.MinAhead, song.ID); err != nil {
				return nil, nil, fmt.Errorf("auto-refill queue: %w", err)
			}
		}
	}

	entry := &models.HistoryEntry{
		ID:       uuid.New().String(),
		SongID:   song.ID,
		PlayedAt: time.Now(),
		Finished: false,
	}
	if err := m.history.RecordStart(ctx, entry); err != nil {
		return nil, nil, fmt.Errorf("record history: %w", err)
	}

	return song, entry, nil
}

// autoSelect picks the next song according to the shuffle strategy.
// Must be called with m.mu held.
func (m *Manager) autoSelect(ctx context.Context) (*models.Song, error) {
	allSongs, err := m.songs.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list songs: %w", err)
	}
	if len(allSongs) == 0 {
		return nil, fmt.Errorf("no songs available")
	}

	return m.pickByStrategy(ctx, allSongs)
}

func (m *Manager) pickByStrategy(ctx context.Context, songs []*models.Song) (*models.Song, error) {
	if len(songs) == 0 {
		return nil, fmt.Errorf("no candidate songs available")
	}

	switch m.cfg.Shuffle.Strategy {
	case ShuffleRandom:
		return songs[rand.Intn(len(songs))], nil //nolint:gosec

	case ShuffleRoundRobin:
		// Play every song before repeating any; treat window = total songs.
		recentIDs, err := m.history.GetRecentSongIDs(ctx, len(songs))
		if err != nil {
			return nil, fmt.Errorf("get recent songs: %w", err)
		}
		return m.pickExcluding(songs, setOf(recentIDs)), nil

	case ShuffleLeastPlayed:
		counts, err := m.history.GetSongPlayCounts(ctx)
		if err != nil {
			return nil, err
		}
		minCnt := int(^uint(0) >> 1)
		for _, s := range songs {
			if c := counts[s.ID]; c < minCnt {
				minCnt = c
			}
		}
		var candidates []*models.Song
		for _, s := range songs {
			if counts[s.ID] == minCnt {
				candidates = append(candidates, s)
			}
		}
		return candidates[rand.Intn(len(candidates))], nil //nolint:gosec

	default: // weighted_history
		window := m.cfg.Shuffle.RecentWindow
		if window <= 0 {
			window = len(songs) / 2
			if window > 20 {
				window = 20
			}
		}
		recentIDs, err := m.history.GetRecentSongIDs(ctx, window)
		if err != nil {
			return nil, fmt.Errorf("get recent songs: %w", err)
		}
		return m.pickExcluding(songs, setOf(recentIDs)), nil
	}
}

// pickExcluding selects a random song not in the exclusion set;
// falls back to full list if every song is excluded.
func (m *Manager) pickExcluding(all []*models.Song, exclude map[string]struct{}) *models.Song {
	candidates := make([]*models.Song, 0, len(all))
	for _, s := range all {
		if _, skip := exclude[s.ID]; !skip {
			candidates = append(candidates, s)
		}
	}
	if len(candidates) == 0 {
		candidates = all
	}
	return candidates[rand.Intn(len(candidates))] //nolint:gosec
}

// fillQueue refills the queue up to targetDepth using the shuffle strategy.
// Must be called with m.mu held.
func (m *Manager) fillQueue(ctx context.Context, targetDepth int, excludeSongIDs ...string) error {
	if targetDepth <= 0 {
		return nil
	}

	items, err := m.queue.List(ctx)
	if err != nil {
		return fmt.Errorf("list queue: %w", err)
	}

	queued := make(map[string]struct{}, len(items))
	for _, item := range items {
		queued[item.SongID] = struct{}{}
	}
	for _, id := range excludeSongIDs {
		if id != "" {
			queued[id] = struct{}{}
		}
	}

	for len(items) < targetDepth {
		song, err := m.autoSelectExcluding(ctx, queued)
		if err != nil {
			return err
		}
		if song == nil {
			break
		}
		item := &models.QueueItem{
			ID:      uuid.New().String(),
			SongID:  song.ID,
			Source:  models.QueueSourceAuto,
			AddedAt: time.Now(),
		}
		if err := m.queue.Enqueue(ctx, item); err != nil {
			return fmt.Errorf("enqueue auto song: %w", err)
		}
		items = append(items, item)
		queued[song.ID] = struct{}{}
	}
	return nil
}

func (m *Manager) autoSelectExcluding(ctx context.Context, queued map[string]struct{}) (*models.Song, error) {
	allSongs, err := m.songs.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list songs: %w", err)
	}
	if len(allSongs) == 0 {
		return nil, fmt.Errorf("no songs available")
	}

	filtered := make([]*models.Song, 0, len(allSongs))
	for _, song := range allSongs {
		if _, exists := queued[song.ID]; !exists {
			filtered = append(filtered, song)
		}
	}
	if len(filtered) == 0 {
		return nil, nil
	}

	return m.pickByStrategy(ctx, filtered)
}

func setOf(ids []string) map[string]struct{} {
	m := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		m[id] = struct{}{}
	}
	return m
}

// AddToQueue validates that a song exists and appends it to the playback queue.
func (m *Manager) AddToQueue(ctx context.Context, songID string, source models.QueueSource) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, err := m.songs.GetByID(ctx, songID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: %s", ErrSongNotFound, songID)
		}
		return fmt.Errorf("get song %s: %w", songID, err)
	}
	item := &models.QueueItem{
		ID:      uuid.New().String(),
		SongID:  songID,
		Source:  source,
		AddedAt: time.Now(),
	}
	return m.queue.Enqueue(ctx, item)
}

// MarkSongFinished records that the song identified by historyID finished playing.
func (m *Manager) MarkSongFinished(ctx context.Context, historyID string) error {
	return m.history.MarkFinished(ctx, historyID, time.Now())
}

// ListQueue returns the current contents of the playback queue.
func (m *Manager) ListQueue(ctx context.Context) ([]*models.QueueItem, error) {
	return m.queue.List(ctx)
}

// SkipCurrent advances playback and returns the next selected song.
func (m *Manager) SkipCurrent(ctx context.Context) (*models.Song, *models.HistoryEntry, error) {
	return m.NextSong(ctx)
}

// ClearQueue removes all pending queue entries.
func (m *Manager) ClearQueue(ctx context.Context) error {
	return m.queue.Clear(ctx)
}
