package repository

import (
	"context"
	"database/sql"
	"time"

	"lofi-radio-backend/internal/models"
)

// HistoryRepository defines persistence operations for play history.
type HistoryRepository interface {
	RecordStart(ctx context.Context, entry *models.HistoryEntry) error
	MarkFinished(ctx context.Context, id string, finishedAt time.Time) error
	GetRecentSongIDs(ctx context.Context, n int) ([]string, error)
	List(ctx context.Context, limit int) ([]*models.HistoryEntry, error)
	Count(ctx context.Context) (int, error)
}

// SQLiteHistoryRepo is the SQLite-backed implementation of HistoryRepository.
type SQLiteHistoryRepo struct {
	db *sql.DB
}

// NewHistoryRepo creates a new SQLiteHistoryRepo.
func NewHistoryRepo(db *sql.DB) *SQLiteHistoryRepo {
	return &SQLiteHistoryRepo{db: db}
}

// RecordStart inserts a new history entry when a song begins playing.
func (r *SQLiteHistoryRepo) RecordStart(ctx context.Context, entry *models.HistoryEntry) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO history (id, song_id, played_at, finished) VALUES (?,?,?,0)`,
		entry.ID, entry.SongID, entry.PlayedAt,
	)
	return err
}

// MarkFinished marks a history entry as finished at the given time.
func (r *SQLiteHistoryRepo) MarkFinished(ctx context.Context, id string, finishedAt time.Time) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE history SET finished=1, finished_at=? WHERE id=?`,
		finishedAt, id,
	)
	return err
}

// GetRecentSongIDs returns the IDs of the n most recently played songs, newest first.
func (r *SQLiteHistoryRepo) GetRecentSongIDs(ctx context.Context, n int) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT DISTINCT song_id FROM history ORDER BY played_at DESC LIMIT ?`,
		n,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// List returns up to limit history entries ordered by played_at descending, with song data populated.
func (r *SQLiteHistoryRepo) List(ctx context.Context, limit int) ([]*models.HistoryEntry, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT h.id, h.song_id, h.played_at, h.finished_at, h.finished,
		        s.id, s.filename, s.path, s.title, s.size_bytes, s.added_at
		 FROM history h
		 JOIN songs s ON s.id = h.song_id
		 ORDER BY h.played_at DESC
		 LIMIT ?`,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []*models.HistoryEntry
	for rows.Next() {
		e := &models.HistoryEntry{Song: &models.Song{}}
		var finishedAt sql.NullTime
		err := rows.Scan(
			&e.ID, &e.SongID, &e.PlayedAt, &finishedAt, &e.Finished,
			&e.Song.ID, &e.Song.Filename, &e.Song.Path, &e.Song.Title, &e.Song.SizeBytes, &e.Song.AddedAt,
		)
		if err != nil {
			return nil, err
		}
		if finishedAt.Valid {
			t := finishedAt.Time
			e.FinishedAt = &t
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// Count returns the total number of history entries.
func (r *SQLiteHistoryRepo) Count(ctx context.Context) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM history`).Scan(&count)
	return count, err
}
