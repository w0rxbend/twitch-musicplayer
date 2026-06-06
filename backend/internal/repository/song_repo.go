package repository

import "context"

import "lofi-radio-backend/internal/models"

// SongRepository defines persistence operations for songs.
type SongRepository interface {
	Create(ctx context.Context, song *models.Song) error
	GetByID(ctx context.Context, id string) (*models.Song, error)
	List(ctx context.Context) ([]*models.Song, error)
	Search(ctx context.Context, query string) ([]*models.Song, error)
	ExistsByPath(ctx context.Context, path string) (bool, error)
	Count(ctx context.Context) (int, error)
}
