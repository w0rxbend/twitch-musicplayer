package repository

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"lofi-radio-backend/internal/database"
	"lofi-radio-backend/internal/models"
)

func newRepositoryTestDB(t *testing.T) *sql.DB {
	t.Helper()

	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	if err := database.RunMigrations(db); err != nil {
		t.Fatalf("migrate sqlite: %v", err)
	}
	return db
}

func createRepositoryTestSong(t *testing.T, ctx context.Context, repo *SQLiteSongRepo) *models.Song {
	t.Helper()

	song := &models.Song{
		ID:           "song-1",
		Filename:     "song-1.mp3",
		Path:         "/music/song-1.mp3",
		Title:        "Song One",
		Artist:       "Artist",
		Album:        "Album",
		DurationSecs: 123,
		SizeBytes:    456,
		AddedAt:      time.Now().Add(-time.Hour),
	}
	if err := repo.Create(ctx, song); err != nil {
		t.Fatalf("create song: %v", err)
	}
	return song
}

func TestQueueRepoListAndDequeueUseQualifiedSongFields(t *testing.T) {
	ctx := context.Background()
	db := newRepositoryTestDB(t)
	songRepo := NewSongRepo(db)
	queueRepo := NewQueueRepo(db)
	song := createRepositoryTestSong(t, ctx, songRepo)

	if err := queueRepo.Enqueue(ctx, &models.QueueItem{
		ID:      "queue-1",
		SongID:  song.ID,
		Source:  models.QueueSourceAuto,
		AddedAt: time.Now(),
	}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	items, err := queueRepo.List(ctx)
	if err != nil {
		t.Fatalf("list queue: %v", err)
	}
	if len(items) != 1 || items[0].Song == nil || items[0].Song.ID != song.ID {
		t.Fatalf("unexpected queue items: %#v", items)
	}

	item, err := queueRepo.Dequeue(ctx)
	if err != nil {
		t.Fatalf("dequeue: %v", err)
	}
	if item.Song == nil || item.Song.ID != song.ID {
		t.Fatalf("unexpected dequeued item: %#v", item)
	}
}
