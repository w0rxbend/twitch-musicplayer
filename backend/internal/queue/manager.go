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
	RecentWindow int // unused, kept for config compat
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
		Shuffle: ShuffleConfig{Strategy: ShuffleRoundRobin},
		Fill:    FillConfig{Strategy: FillAutoRefill, MinAhead: 1, PreloadSize: 3},
	}
}

// --- local repository interfaces (avoids circular import) ---

type SongRepository interface {
	List(ctx context.Context) ([]*models.Song, error)
	GetByID(ctx context.Context, id string) (*models.Song, error)
	Count(ctx context.Context) (int, error)
}

// PlayedTracker is the Bloom filter interface for tracking played songs.
type PlayedTracker interface {
	MarkPlayed(songID string)
	HasPlayed(songID string) bool
	Reset()
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
	tracker PlayedTracker
	queue   QueueRepository
	cfg     ManagerConfig
	mu      sync.Mutex
}

// New constructs a Manager. Pass a zero-value ManagerConfig to use defaults.
func New(songs SongRepository, tracker PlayedTracker, queue QueueRepository, cfg ManagerConfig) *Manager {
	if cfg.Shuffle.Strategy == "" {
		cfg = defaultConfig()
	}
	return &Manager{songs: songs, tracker: tracker, queue: queue, cfg: cfg}
}

// InitialQueueTarget returns the configured queue depth to prepare before playback starts.
func (m *Manager) InitialQueueTarget() int {
	return m.initialQueueTarget()
}

// PrepareInitialQueue fills the queue to the configured startup depth.
func (m *Manager) PrepareInitialQueue(ctx context.Context) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	targetDepth := m.initialQueueTarget()
	if targetDepth <= 0 {
		return 0, nil
	}

	totalSongs, err := m.songs.Count(ctx)
	if err != nil {
		return 0, fmt.Errorf("count songs: %w", err)
	}
	if totalSongs == 0 {
		return 0, nil
	}

	before, err := m.queue.Count(ctx)
	if err != nil {
		return 0, fmt.Errorf("count queue before prepare: %w", err)
	}
	if before >= targetDepth {
		return 0, nil
	}

	if err := m.fillQueue(ctx, targetDepth); err != nil {
		return 0, err
	}

	after, err := m.queue.Count(ctx)
	if err != nil {
		return 0, fmt.Errorf("count queue after prepare: %w", err)
	}
	return after - before, nil
}

func (m *Manager) initialQueueTarget() int {
	switch m.cfg.Fill.Strategy {
	case FillManualOnly:
		return 0
	case FillAutoRefill:
		return m.cfg.Fill.MinAhead
	case FillPreload:
		return m.cfg.Fill.PreloadSize
	default:
		return 0
	}
}

// NextSong selects the next song according to the configured fill and shuffle strategies.
// It marks the song as played in the tracker and returns it.
func (m *Manager) NextSong(ctx context.Context) (*models.Song, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var song *models.Song

	// manual_only: only dequeue; never auto-select.
	if m.cfg.Fill.Strategy == FillManualOnly {
		item, err := m.queue.Dequeue(ctx)
		if errors.Is(err, sql.ErrNoRows) || item == nil {
			return nil, ErrQueueEmpty
		}
		if err != nil {
			return nil, fmt.Errorf("dequeue: %w", err)
		}
		s, err := m.songs.GetByID(ctx, item.SongID)
		if err != nil {
			return nil, fmt.Errorf("get queued song: %w", err)
		}
		song = s
	} else {
		// Try the queue first; auto-select if empty.
		item, err := m.queue.Dequeue(ctx)
		if errors.Is(err, sql.ErrNoRows) || item == nil {
			var selErr error
			song, selErr = m.autoSelect(ctx)
			if selErr != nil {
				return nil, fmt.Errorf("auto-select: %w", selErr)
			}
		} else if err != nil {
			return nil, fmt.Errorf("dequeue: %w", err)
		} else {
			var getErr error
			song, getErr = m.songs.GetByID(ctx, item.SongID)
			if getErr != nil {
				return nil, fmt.Errorf("get queued song: %w", getErr)
			}
		}

		switch m.cfg.Fill.Strategy {
		case FillPreload:
			if err := m.fillQueue(ctx, m.cfg.Fill.PreloadSize, song.ID); err != nil {
				return nil, fmt.Errorf("preload queue: %w", err)
			}
		case FillAutoRefill:
			if err := m.fillQueue(ctx, m.cfg.Fill.MinAhead, song.ID); err != nil {
				return nil, fmt.Errorf("auto-refill queue: %w", err)
			}
		}
	}

	m.tracker.MarkPlayed(song.ID)
	return song, nil
}

// autoSelect picks the next song according to the shuffle strategy.
// Resets the tracker if all songs have been played (round-robin cycle complete).
// Must be called with m.mu held.
func (m *Manager) autoSelect(ctx context.Context) (*models.Song, error) {
	allSongs, err := m.songs.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list songs: %w", err)
	}
	if len(allSongs) == 0 {
		return nil, fmt.Errorf("no songs available")
	}

	// For non-random strategies, reset the tracker when all songs have been played.
	if m.cfg.Shuffle.Strategy != ShuffleRandom {
		allPlayed := true
		for _, s := range allSongs {
			if !m.tracker.HasPlayed(s.ID) {
				allPlayed = false
				break
			}
		}
		if allPlayed {
			m.tracker.Reset()
		}
	}

	return m.pickByStrategy(allSongs)
}

func (m *Manager) pickByStrategy(songs []*models.Song) (*models.Song, error) {
	if len(songs) == 0 {
		return nil, fmt.Errorf("no candidate songs available")
	}

	switch m.cfg.Shuffle.Strategy {
	case ShuffleRandom:
		return songs[rand.Intn(len(songs))], nil //nolint:gosec

	case ShuffleRoundRobin, ShuffleWeightedHistory:
		// Play every song before repeating any (bloom filter cycle).
		unplayed := filterUnplayed(songs, m.tracker)
		if len(unplayed) == 0 {
			unplayed = songs
		}
		return unplayed[rand.Intn(len(unplayed))], nil //nolint:gosec

	case ShuffleLeastPlayed:
		// Prefer unplayed songs; fall back to random when all have been played.
		unplayed := filterUnplayed(songs, m.tracker)
		if len(unplayed) > 0 {
			return unplayed[rand.Intn(len(unplayed))], nil //nolint:gosec
		}
		return songs[rand.Intn(len(songs))], nil //nolint:gosec

	default:
		return songs[rand.Intn(len(songs))], nil //nolint:gosec
	}
}

// filterUnplayed returns the subset of songs the tracker has not seen.
func filterUnplayed(songs []*models.Song, t PlayedTracker) []*models.Song {
	out := make([]*models.Song, 0, len(songs))
	for _, s := range songs {
		if !t.HasPlayed(s.ID) {
			out = append(out, s)
		}
	}
	return out
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

	return m.pickByStrategy(filtered)
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

// ListQueue returns the current contents of the playback queue.
func (m *Manager) ListQueue(ctx context.Context) ([]*models.QueueItem, error) {
	return m.queue.List(ctx)
}

// SkipCurrent advances playback and returns the next selected song.
func (m *Manager) SkipCurrent(ctx context.Context) (*models.Song, error) {
	return m.NextSong(ctx)
}

// ClearQueue removes all pending queue entries.
func (m *Manager) ClearQueue(ctx context.Context) error {
	return m.queue.Clear(ctx)
}
