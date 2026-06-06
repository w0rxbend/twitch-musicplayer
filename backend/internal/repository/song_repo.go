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

const songFields = `id, filename, path, title, artist, album, duration_secs, size_bytes, added_at`
const qualifiedSongFields = `s.id, s.filename, s.path, s.title, s.artist, s.album, s.duration_secs, s.size_bytes, s.added_at`

func scanSong(row interface{ Scan(...any) error }, s *models.Song) error {
	return row.Scan(&s.ID, &s.Filename, &s.Path, &s.Title, &s.Artist, &s.Album, &s.DurationSecs, &s.SizeBytes, &s.AddedAt)
}

// SQLiteSongRepo is the SQLite-backed implementation of SongRepository.
type SQLiteSongRepo struct{ db *sql.DB }

// NewSongRepo creates a new SQLiteSongRepo.
func NewSongRepo(db *sql.DB) *SQLiteSongRepo { return &SQLiteSongRepo{db: db} }

func (r *SQLiteSongRepo) Create(ctx context.Context, song *models.Song) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO songs (id, filename, path, title, artist, album, duration_secs, size_bytes, added_at)
		 VALUES (?,?,?,?,?,?,?,?,?)`,
		song.ID, song.Filename, song.Path, song.Title, song.Artist, song.Album,
		song.DurationSecs, song.SizeBytes, song.AddedAt,
	)
	return err
}

func (r *SQLiteSongRepo) GetByID(ctx context.Context, id string) (*models.Song, error) {
	s := &models.Song{}
	err := scanSong(r.db.QueryRowContext(ctx,
		`SELECT `+songFields+` FROM songs WHERE id = ?`, id,
	), s)
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (r *SQLiteSongRepo) List(ctx context.Context) ([]*models.Song, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT `+songFields+` FROM songs ORDER BY added_at ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var songs []*models.Song
	for rows.Next() {
		s := &models.Song{}
		if err := scanSong(rows, s); err != nil {
			return nil, err
		}
		songs = append(songs, s)
	}
	return songs, rows.Err()
}

func (r *SQLiteSongRepo) ExistsByPath(ctx context.Context, path string) (bool, error) {
	var count int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM songs WHERE path = ?`, path).Scan(&count)
	return count > 0, err
}

func (r *SQLiteSongRepo) Count(ctx context.Context) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM songs`).Scan(&count)
	return count, err
}
