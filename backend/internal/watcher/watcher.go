package watcher

import (
	"context"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/google/uuid"
	"lofi-radio-backend/internal/meta"
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

// OnNewSong is called after a newly discovered song is registered.
type OnNewSong func(song *models.Song)

// ScanSummary describes the startup folder scan.
type ScanSummary struct {
	MusicFiles     int
	NewlyIndexed   int
	AlreadyIndexed int
	WatchedDirs    int
}

// Watcher monitors a directory tree for new audio files and registers them.
type Watcher struct {
	dir        string
	extensions map[string]struct{}
	songRepo   SongRepository
	queueMgr   QueueManager
	fsWatcher  *fsnotify.Watcher
	onNewSong  OnNewSong
	logger     *log.Logger
}

// New creates a Watcher. extensions is the list of file suffixes to index (e.g. [".mp3"]).
func New(dir string, extensions []string, songRepo SongRepository, queueMgr QueueManager, onNewSong OnNewSong) (*Watcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	if err := fsw.Add(dir); err != nil {
		fsw.Close()
		return nil, err
	}

	extSet := make(map[string]struct{}, len(extensions))
	for _, e := range extensions {
		extSet[strings.ToLower(e)] = struct{}{}
	}
	if len(extSet) == 0 {
		extSet[".mp3"] = struct{}{}
	}

	return &Watcher{
		dir:        dir,
		extensions: extSet,
		songRepo:   songRepo,
		queueMgr:   queueMgr,
		fsWatcher:  fsw,
		onNewSong:  onNewSong,
		logger:     log.New(log.Writer(), "[watcher] ", log.LstdFlags),
	}, nil
}

// ScanExisting walks the entire music directory tree and inserts any audio files
// not yet tracked in the DB. Does NOT add songs to the queue.
func (w *Watcher) ScanExisting(ctx context.Context) (*ScanSummary, error) {
	summary := &ScanSummary{}
	err := filepath.WalkDir(w.dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || ctx.Err() != nil {
			return err
		}
		if d.IsDir() {
			if path != w.dir {
				// Watch every subdirectory so we catch new files in nested dirs.
				if err := w.fsWatcher.Add(path); err == nil {
					summary.WatchedDirs++
				}
			}
			return nil
		}
		if !w.isMusicFile(path) {
			return nil
		}
		summary.MusicFiles++
		_, created, err := w.registerFile(ctx, path, false)
		if err != nil {
			return err
		}
		if created {
			summary.NewlyIndexed++
		} else {
			summary.AlreadyIndexed++
		}
		return nil
	})
	return summary, err
}

// Start watches the directory tree for new files. Blocks until ctx is done.
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

			// Give the OS a moment to finish writing.
			time.Sleep(200 * time.Millisecond)

			info, err := os.Stat(event.Name)
			if err != nil {
				continue
			}

			if info.IsDir() {
				// New subdirectory: watch it and scan for any files already inside.
				_ = w.fsWatcher.Add(event.Name)
				_ = w.scanDir(ctx, event.Name, true)
				continue
			}

			if !w.isMusicFile(event.Name) {
				continue
			}

			if _, _, err := w.registerFile(ctx, event.Name, true); err != nil {
				w.logger.Printf("register %s: %v", event.Name, err)
			}

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

// scanDir walks a single directory (non-recursive) and registers music files.
func (w *Watcher) scanDir(ctx context.Context, dir string, addToQueue bool) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		path := filepath.Join(dir, e.Name())
		if !w.isMusicFile(path) {
			continue
		}
		if _, _, err := w.registerFile(ctx, path, addToQueue); err != nil {
			w.logger.Printf("register %s: %v", path, err)
		}
	}
	return nil
}

// registerFile inserts a new song record and optionally queues it.
func (w *Watcher) registerFile(ctx context.Context, path string, addToQueue bool) (*models.Song, bool, error) {
	exists, err := w.songRepo.ExistsByPath(ctx, path)
	if err != nil {
		return nil, false, err
	}
	if exists {
		return nil, false, nil
	}

	stat, err := os.Stat(path)
	if err != nil {
		return nil, false, err
	}

	m := meta.Extract(path)

	song := &models.Song{
		// UUIDv5 derived from the absolute path — stable across restarts so
		// the Bloom filter stays valid without a persistent database.
		ID:           uuid.NewSHA1(uuid.NameSpaceURL, []byte(path)).String(),
		Filename:     filepath.Base(path),
		Path:         path,
		Title:        m.Title,
		Artist:       m.Artist,
		Album:        m.Album,
		DurationSecs: m.DurationSecs,
		SizeBytes:    stat.Size(),
		AddedAt:      time.Now(),
	}

	if err := w.songRepo.Create(ctx, song); err != nil {
		return nil, false, err
	}
	w.logger.Printf("indexed: %s (%.0fs)", song.Title, song.DurationSecs)

	if addToQueue {
		if err := w.queueMgr.AddToQueue(ctx, song.ID, models.QueueSourceAuto); err != nil {
			w.logger.Printf("queue %s: %v", song.Filename, err)
		}
		if w.onNewSong != nil {
			w.onNewSong(song)
		}
	}

	return song, true, nil
}

func (w *Watcher) isMusicFile(path string) bool {
	_, ok := w.extensions[strings.ToLower(filepath.Ext(path))]
	return ok
}
