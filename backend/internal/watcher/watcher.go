package watcher

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/google/uuid"
	"lofi-radio-backend/internal/models"
)

// SongRepository is the subset needed by the watcher.
type SongRepository interface {
	ExistsByPath(ctx context.Context, path string) (bool, error)
	Create(ctx context.Context, song *models.Song) error
}

// QueueManager is the subset needed by the watcher.
type QueueManager interface {
	AddToQueue(ctx context.Context, songID string, source models.QueueSource) error
}

// OnNewSong is called after a new song is added, so the WebSocket hub can broadcast.
type OnNewSong func(song *models.Song)

// Watcher monitors a directory for new .mp3 files and registers them in the DB.
type Watcher struct {
	dir       string
	songRepo  SongRepository
	queueMgr  QueueManager
	fsWatcher *fsnotify.Watcher
	onNewSong OnNewSong
	logger    *log.Logger
}

// New creates a new Watcher that monitors dir for new .mp3 files.
func New(dir string, songRepo SongRepository, queueMgr QueueManager, onNewSong OnNewSong) (*Watcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	if err := fsw.Add(dir); err != nil {
		fsw.Close()
		return nil, err
	}

	return &Watcher{
		dir:       dir,
		songRepo:  songRepo,
		queueMgr:  queueMgr,
		fsWatcher: fsw,
		onNewSong: onNewSong,
		logger:    log.New(log.Writer(), "[watcher] ", log.LstdFlags),
	}, nil
}

// ScanExisting scans the music dir on startup and inserts any .mp3 files not yet in the DB.
// It does NOT add them to the queue (they are already known songs; queue is managed separately).
func (w *Watcher) ScanExisting(ctx context.Context) error {
	entries, err := os.ReadDir(w.dir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		filename := entry.Name()
		if strings.ToLower(filepath.Ext(filename)) != ".mp3" {
			continue
		}

		fullPath := filepath.Join(w.dir, filename)

		exists, err := w.songRepo.ExistsByPath(ctx, fullPath)
		if err != nil {
			w.logger.Printf("error checking existence of %s: %v", fullPath, err)
			continue
		}
		if exists {
			continue
		}

		info, err := os.Stat(fullPath)
		if err != nil {
			w.logger.Printf("error stat-ing %s: %v", fullPath, err)
			continue
		}

		song := &models.Song{
			ID:        uuid.New().String(),
			Filename:  filename,
			Path:      fullPath,
			Title:     strings.TrimSuffix(filename, ".mp3"),
			SizeBytes: info.Size(),
			AddedAt:   time.Now(),
		}

		if err := w.songRepo.Create(ctx, song); err != nil {
			w.logger.Printf("error creating song record for %s: %v", fullPath, err)
			continue
		}

		w.logger.Printf("added existing song: %s", filename)
	}

	return nil
}

// Start watches the directory for new files. Blocks until ctx is done.
func (w *Watcher) Start(ctx context.Context) error {
	defer w.fsWatcher.Close()

	for {
		select {
		case event, ok := <-w.fsWatcher.Events:
			if !ok {
				return nil
			}

			if !event.Has(fsnotify.Create) {
				continue
			}

			filename := filepath.Base(event.Name)
			if strings.ToLower(filepath.Ext(filename)) != ".mp3" {
				continue
			}

			// Small sleep to let the file finish writing before we stat it.
			time.Sleep(200 * time.Millisecond)

			fullPath := event.Name

			exists, err := w.songRepo.ExistsByPath(ctx, fullPath)
			if err != nil {
				w.logger.Printf("error checking existence of %s: %v", fullPath, err)
				continue
			}
			if exists {
				continue
			}

			info, err := os.Stat(fullPath)
			if err != nil {
				w.logger.Printf("error stat-ing new file %s: %v", fullPath, err)
				continue
			}

			song := &models.Song{
				ID:        uuid.New().String(),
				Filename:  filename,
				Path:      fullPath,
				Title:     strings.TrimSuffix(filename, ".mp3"),
				SizeBytes: info.Size(),
				AddedAt:   time.Now(),
			}

			if err := w.songRepo.Create(ctx, song); err != nil {
				w.logger.Printf("error creating song record for %s: %v", fullPath, err)
				continue
			}

			if err := w.queueMgr.AddToQueue(ctx, song.ID, models.QueueSourceAuto); err != nil {
				w.logger.Printf("error adding %s to queue: %v", filename, err)
			}

			if w.onNewSong != nil {
				w.onNewSong(song)
			}

			w.logger.Printf("detected and queued new song: %s", filename)

		case err, ok := <-w.fsWatcher.Errors:
			if !ok {
				return nil
			}
			w.logger.Printf("fsnotify error: %v", err)

		case <-ctx.Done():
			return nil
		}
	}
}
