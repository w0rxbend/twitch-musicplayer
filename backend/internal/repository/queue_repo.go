package repository

import "context"

import "lofi-radio-backend/internal/models"

// QueueRepository defines persistence operations for the playback queue.
type QueueRepository interface {
	Enqueue(ctx context.Context, item *models.QueueItem) error
	EnqueueFront(ctx context.Context, item *models.QueueItem) error
	Dequeue(ctx context.Context) (*models.QueueItem, error)
	List(ctx context.Context) ([]*models.QueueItem, error)
	Remove(ctx context.Context, id string) error
	Clear(ctx context.Context) error
	Count(ctx context.Context) (int, error)
}
