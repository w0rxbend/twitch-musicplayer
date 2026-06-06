package repository

import (
	"context"
	"database/sql"

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

// SQLiteQueueRepo is the SQLite-backed implementation of QueueRepository.
type SQLiteQueueRepo struct {
	db *sql.DB
}

// NewQueueRepo creates a new SQLiteQueueRepo.
func NewQueueRepo(db *sql.DB) *SQLiteQueueRepo {
	return &SQLiteQueueRepo{db: db}
}

// Enqueue appends an item to the queue, automatically assigning the next position.
func (r *SQLiteQueueRepo) Enqueue(ctx context.Context, item *models.QueueItem) error {
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

// Dequeue removes and returns the lowest-position item in the queue with its song populated.
// Returns sql.ErrNoRows if the queue is empty.
func (r *SQLiteQueueRepo) Dequeue(ctx context.Context) (*models.QueueItem, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck

	item := &models.QueueItem{Song: &models.Song{}}
	err = tx.QueryRowContext(ctx,
		`SELECT q.id, q.song_id, q.position, q.source, q.added_at,
		        s.id, s.filename, s.path, s.title, s.size_bytes, s.added_at
		 FROM queue q
		 JOIN songs s ON s.id = q.song_id
		 ORDER BY q.position ASC
		 LIMIT 1`,
	).Scan(
		&item.ID, &item.SongID, &item.Position, &item.Source, &item.AddedAt,
		&item.Song.ID, &item.Song.Filename, &item.Song.Path, &item.Song.Title, &item.Song.SizeBytes, &item.Song.AddedAt,
	)
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

// List returns all queue items ordered by position ascending, with songs populated.
func (r *SQLiteQueueRepo) List(ctx context.Context) ([]*models.QueueItem, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT q.id, q.song_id, q.position, q.source, q.added_at,
		        s.id, s.filename, s.path, s.title, s.size_bytes, s.added_at
		 FROM queue q
		 JOIN songs s ON s.id = q.song_id
		 ORDER BY q.position ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []*models.QueueItem
	for rows.Next() {
		item := &models.QueueItem{Song: &models.Song{}}
		err := rows.Scan(
			&item.ID, &item.SongID, &item.Position, &item.Source, &item.AddedAt,
			&item.Song.ID, &item.Song.Filename, &item.Song.Path, &item.Song.Title, &item.Song.SizeBytes, &item.Song.AddedAt,
		)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// Remove deletes a specific queue item by ID.
func (r *SQLiteQueueRepo) Remove(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM queue WHERE id=?`, id)
	return err
}

// Clear removes all items from the queue.
func (r *SQLiteQueueRepo) Clear(ctx context.Context) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM queue`)
	return err
}

// Count returns the total number of items currently in the queue.
func (r *SQLiteQueueRepo) Count(ctx context.Context) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM queue`).Scan(&count)
	return count, err
}
