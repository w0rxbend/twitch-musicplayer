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
	GetSongPlayCounts(ctx context.Context) (map[string]int, error)
	List(ctx context.Context, limit int) ([]*models.HistoryEntry, error)
	Count(ctx context.Context) (int, error)
}

// SQLiteHistoryRepo is the SQLite-backed implementation of HistoryRepository.
type SQLiteHistoryRepo struct{ db *sql.DB }

func NewHistoryRepo(db *sql.DB) *SQLiteHistoryRepo { return &SQLiteHistoryRepo{db: db} }

func (r *SQLiteHistoryRepo) RecordStart(ctx context.Context, entry *models.HistoryEntry) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO history (id, song_id, played_at, finished) VALUES (?,?,?,0)`,
		entry.ID, entry.SongID, entry.PlayedAt,
	)
	return err
}

func (r *SQLiteHistoryRepo) MarkFinished(ctx context.Context, id string, finishedAt time.Time) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE history SET finished=1, finished_at=? WHERE id=?`,
		finishedAt, id,
	)
	return err
}

func (r *SQLiteHistoryRepo) GetRecentSongIDs(ctx context.Context, n int) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT DISTINCT song_id FROM history ORDER BY played_at DESC LIMIT ?`, n,
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

// GetSongPlayCounts returns a map of song_id → total play count for the least_played strategy.
func (r *SQLiteHistoryRepo) GetSongPlayCounts(ctx context.Context) (map[string]int, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT song_id, COUNT(*) FROM history GROUP BY song_id`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	counts := make(map[string]int)
	for rows.Next() {
		var id string
		var cnt int
		if err := rows.Scan(&id, &cnt); err != nil {
			return nil, err
		}
		counts[id] = cnt
	}
	return counts, rows.Err()
}

func (r *SQLiteHistoryRepo) List(ctx context.Context, limit int) ([]*models.HistoryEntry, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT h.id, h.song_id, h.played_at, h.finished_at, h.finished,
		        s.`+songFields+`
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
			&e.Song.ID, &e.Song.Filename, &e.Song.Path, &e.Song.Title,
			&e.Song.Artist, &e.Song.Album, &e.Song.DurationSecs,
			&e.Song.SizeBytes, &e.Song.AddedAt,
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

func (r *SQLiteHistoryRepo) Count(ctx context.Context) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM history`).Scan(&count)
	return count, err
}
