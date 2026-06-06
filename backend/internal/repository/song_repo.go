package repository

import (
	"context"
	"database/sql"

	"lofi-radio-backend/internal/models"
)

// SongRepository defines persistence operations for songs.
type SongRepository interface {
	Create(ctx context.Context, song *models.Song) error
	GetByID(ctx context.Context, id string) (*models.Song, error)
	List(ctx context.Context) ([]*models.Song, error)
	ExistsByPath(ctx context.Context, path string) (bool, error)
	Count(ctx context.Context) (int, error)
}

// SQLiteSongRepo is the SQLite-backed implementation of SongRepository.
type SQLiteSongRepo struct {
	db *sql.DB
}

// NewSongRepo creates a new SQLiteSongRepo.
func NewSongRepo(db *sql.DB) *SQLiteSongRepo {
	return &SQLiteSongRepo{db: db}
}

// Create inserts a new song record.
func (r *SQLiteSongRepo) Create(ctx context.Context, song *models.Song) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO songs (id, filename, path, title, size_bytes, added_at) VALUES (?,?,?,?,?,?)`,
		song.ID, song.Filename, song.Path, song.Title, song.SizeBytes, song.AddedAt,
	)
	return err
}

// GetByID retrieves a single song by its ID.
func (r *SQLiteSongRepo) GetByID(ctx context.Context, id string) (*models.Song, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT id, filename, path, title, size_bytes, added_at FROM songs WHERE id = ?`,
		id,
	)
	song := &models.Song{}
	err := row.Scan(&song.ID, &song.Filename, &song.Path, &song.Title, &song.SizeBytes, &song.AddedAt)
	if err != nil {
		return nil, err
	}
	return song, nil
}

// List returns all songs ordered by added_at ascending.
func (r *SQLiteSongRepo) List(ctx context.Context) ([]*models.Song, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, filename, path, title, size_bytes, added_at FROM songs ORDER BY added_at ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var songs []*models.Song
	for rows.Next() {
		s := &models.Song{}
		if err := rows.Scan(&s.ID, &s.Filename, &s.Path, &s.Title, &s.SizeBytes, &s.AddedAt); err != nil {
			return nil, err
		}
		songs = append(songs, s)
	}
	return songs, rows.Err()
}

// ExistsByPath returns true if a song with the given path already exists.
func (r *SQLiteSongRepo) ExistsByPath(ctx context.Context, path string) (bool, error) {
	var count int
	err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(1) FROM songs WHERE path = ?`,
		path,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// Count returns the total number of songs.
func (r *SQLiteSongRepo) Count(ctx context.Context) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM songs`).Scan(&count)
	return count, err
}
