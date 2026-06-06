package repository

import (
	"context"
	"database/sql"
	"sync"

	"lofi-radio-backend/internal/models"
)

// QueueRepository defines persistence operations for the playback queue.
type QueueRepository interface {
	Enqueue(ctx context.Context, item *models.QueueItem) error
	Dequeue(ctx context.Context) (*models.QueueItem, error)
	List(ctx context.Context) ([]*models.QueueItem, error)
	Remove(ctx context.Context, id string) error
	Clear(ctx context.Context) error
	Count(ctx context.Context) (int, error)
}

const queueSongJoin = `
SELECT q.id, q.song_id, q.position, q.source, q.added_at,
       ` + qualifiedSongFields + `
FROM queue q
JOIN songs s ON s.id = q.song_id`

func scanQueueItem(row interface{ Scan(...any) error }) (*models.QueueItem, error) {
	item := &models.QueueItem{Song: &models.Song{}}
	err := row.Scan(
		&item.ID, &item.SongID, &item.Position, &item.Source, &item.AddedAt,
		&item.Song.ID, &item.Song.Filename, &item.Song.Path, &item.Song.Title,
		&item.Song.Artist, &item.Song.Album, &item.Song.DurationSecs,
		&item.Song.SizeBytes, &item.Song.AddedAt,
	)
	return item, err
}

// SQLiteQueueRepo is the SQLite-backed implementation of QueueRepository.
type SQLiteQueueRepo struct {
	db *sql.DB
	mu sync.Mutex
}

func NewQueueRepo(db *sql.DB) *SQLiteQueueRepo { return &SQLiteQueueRepo{db: db} }

func (r *SQLiteQueueRepo) Enqueue(ctx context.Context, item *models.QueueItem) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	var nextPos int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(position),0)+1 FROM queue`).Scan(&nextPos); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx,
		`INSERT INTO queue (id, song_id, position, source, added_at) VALUES (?,?,?,?,?)`,
		item.ID, item.SongID, nextPos, item.Source, item.AddedAt,
	)
	if err != nil {
		return err
	}
	item.Position = nextPos
	return tx.Commit()
}

func (r *SQLiteQueueRepo) Dequeue(ctx context.Context) (*models.QueueItem, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck

	item, err := scanQueueItem(tx.QueryRowContext(ctx,
		queueSongJoin+` ORDER BY q.position ASC, q.added_at ASC, q.id ASC LIMIT 1`,
	))
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM queue WHERE id=?`, item.ID); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return item, nil
}

func (r *SQLiteQueueRepo) List(ctx context.Context) ([]*models.QueueItem, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	rows, err := r.db.QueryContext(ctx, queueSongJoin+` ORDER BY q.position ASC, q.added_at ASC, q.id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []*models.QueueItem
	for rows.Next() {
		item, err := scanQueueItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *SQLiteQueueRepo) Remove(ctx context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	res, err := r.db.ExecContext(ctx, `DELETE FROM queue WHERE id=?`, id)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *SQLiteQueueRepo) Clear(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	_, err := r.db.ExecContext(ctx, `DELETE FROM queue`)
	return err
}

func (r *SQLiteQueueRepo) Count(ctx context.Context) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	var count int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM queue`).Scan(&count)
	return count, err
}
