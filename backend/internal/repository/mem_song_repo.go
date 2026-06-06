package repository

import (
	"context"
	"database/sql"
	"sort"
	"strings"
	"sync"

	"lofi-radio-backend/internal/models"
)

// MemSongRepo is a thread-safe in-memory implementation of SongRepository.
// Songs are indexed at startup from the filesystem and held for the lifetime
// of the process. No SQLite required.
type MemSongRepo struct {
	mu     sync.RWMutex
	byID   map[string]*models.Song
	byPath map[string]string // path → id
	order  []string          // insertion-order ids (for stable List output)
}

func NewMemSongRepo() *MemSongRepo {
	return &MemSongRepo{
		byID:   make(map[string]*models.Song),
		byPath: make(map[string]string),
	}
}

func (r *MemSongRepo) Create(_ context.Context, song *models.Song) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.byID[song.ID]; !exists {
		r.order = append(r.order, song.ID)
	}
	cp := *song
	r.byID[song.ID] = &cp
	r.byPath[song.Path] = song.ID
	return nil
}

func (r *MemSongRepo) GetByID(_ context.Context, id string) (*models.Song, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.byID[id]
	if !ok {
		return nil, sql.ErrNoRows
	}
	cp := *s
	return &cp, nil
}

func (r *MemSongRepo) List(_ context.Context) ([]*models.Song, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*models.Song, 0, len(r.order))
	for _, id := range r.order {
		if s, ok := r.byID[id]; ok {
			cp := *s
			out = append(out, &cp)
		}
	}
	sortSongs(out)
	return out, nil
}

func (r *MemSongRepo) Search(_ context.Context, query string) ([]*models.Song, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	q := strings.ToLower(query)
	var out []*models.Song
	for _, id := range r.order {
		s, ok := r.byID[id]
		if !ok {
			continue
		}
		if strings.Contains(strings.ToLower(s.Title), q) ||
			strings.Contains(strings.ToLower(s.Artist), q) ||
			strings.Contains(strings.ToLower(s.Album), q) ||
			strings.Contains(strings.ToLower(s.Filename), q) {
			cp := *s
			out = append(out, &cp)
		}
	}
	sortSongs(out)
	return out, nil
}

func (r *MemSongRepo) ExistsByPath(_ context.Context, path string) (bool, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.byPath[path]
	return ok, nil
}

func (r *MemSongRepo) Count(_ context.Context) (int, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.byID), nil
}

func sortSongs(songs []*models.Song) {
	sort.Slice(songs, func(i, j int) bool {
		if songs[i].Title != songs[j].Title {
			return songs[i].Title < songs[j].Title
		}
		return songs[i].Artist < songs[j].Artist
	})
}
