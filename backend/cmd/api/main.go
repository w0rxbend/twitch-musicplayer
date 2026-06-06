package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"lofi-radio-backend/internal/api"
	"lofi-radio-backend/internal/config"
	"lofi-radio-backend/internal/database"
	"lofi-radio-backend/internal/models"
	"lofi-radio-backend/internal/played"
	"lofi-radio-backend/internal/queue"
	"lofi-radio-backend/internal/repository"
	"lofi-radio-backend/internal/server"
	"lofi-radio-backend/internal/watcher"
	"lofi-radio-backend/internal/websocket"
)

func main() {
	cfg := config.Load()

	// ── Database ──────────────────────────────────────────────────────────────
	db := database.NewWithDSN(cfg.DBPath)
	if err := db.Migrate(); err != nil {
		log.Fatalf("migration failed: %v", err)
	}
	sqlDB := db.DB()

	// ── Repositories ─────────────────────────────────────────────────────────
	songRepo := repository.NewSongRepo(sqlDB)
	queueRepo := repository.NewQueueRepo(sqlDB)

	// ── Played tracker (Bloom filter) ─────────────────────────────────────────
	bloomPath := strings.TrimSuffix(cfg.DBPath, filepath.Ext(cfg.DBPath)) + ".bloom"
	playedTracker := played.New(10_000, 0.01)
	if err := playedTracker.Load(bloomPath); err != nil {
		log.Printf("warning: could not load bloom filter from %s: %v", bloomPath, err)
	} else {
		log.Printf("bloom filter loaded from %s (~%d songs played)", bloomPath, playedTracker.ApproxCount())
	}

	// ── Queue manager ─────────────────────────────────────────────────────────
	queueMgr := queue.New(songRepo, playedTracker, queueRepo, queue.ManagerConfig{
		Shuffle: queue.ShuffleConfig{
			Strategy:     queue.ShuffleStrategy(cfg.Shuffle.Strategy),
			RecentWindow: cfg.Shuffle.RecentWindow,
		},
		Fill: queue.FillConfig{
			Strategy:    queue.FillStrategy(cfg.Queue.Strategy),
			MinAhead:    cfg.Queue.MinAhead,
			PreloadSize: cfg.Queue.PreloadSize,
		},
	})

	// ── WebSocket hub ─────────────────────────────────────────────────────────
	hub := websocket.NewHub()
	go hub.Run()

	// ── File watcher ──────────────────────────────────────────────────────────
	fsWatcher, err := watcher.New(
		cfg.MusicDir,
		cfg.Music.Extensions,
		songRepo,
		queueMgr,
		func(_ *models.Song) {
			msg, encErr := websocket.Encode(websocket.MsgQueueUpdated, websocket.QueueUpdatedPayload{
				Reason: "new_file",
			})
			if encErr == nil {
				hub.Broadcast(msg)
			}
		},
	)
	if err != nil {
		log.Fatalf("watcher init failed: %v", err)
	}

	// ── HTTP API handlers ────────────────────────────────────────────────────
	songsH := api.NewSongsHandler(songRepo, cfg.MusicDir)
	queueH := api.NewQueueHandler(queueMgr, queueRepo, hub)
	playerH := api.NewPlayerHandler(songRepo, queueRepo, hub)

	// ── HTTP server ───────────────────────────────────────────────────────────
	httpServer := server.New(server.Options{
		Port:     cfg.Port,
		DB:       db,
		Hub:      hub,
		Songs:    songsH,
		Queue:    queueH,
		Player:   playerH,
		BaseURL:  cfg.BaseURL,
		QueueMgr: queueMgr,
	})

	// ── Background tasks ──────────────────────────────────────────────────────
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	scanSummary, err := fsWatcher.ScanExisting(ctx)
	if err != nil {
		log.Printf("warning: scan existing failed: %v", err)
	}
	queuedAdded, err := queueMgr.PrepareInitialQueue(ctx)
	if err != nil {
		log.Printf("warning: initial queue prepare failed: %v", err)
	}
	songs, err := songRepo.List(ctx)
	if err != nil {
		log.Printf("warning: list songs for startup log failed: %v", err)
	}
	queueItems, err := queueMgr.ListQueue(ctx)
	if err != nil {
		log.Printf("warning: list queue for startup log failed: %v", err)
	}
	logStartupInventory(cfg, scanSummary, songs, queueItems, queueMgr.InitialQueueTarget(), queuedAdded)

	go func() {
		if err := fsWatcher.Start(ctx); err != nil {
			log.Printf("watcher stopped: %v", err)
		}
	}()

	// ── Serve ─────────────────────────────────────────────────────────────────
	done := make(chan bool, 1)
	go func() {
		<-ctx.Done()
		log.Println("shutting down gracefully…")
		stop()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutCtx); err != nil {
			log.Printf("server forced shutdown: %v", err)
		}
		if err := playedTracker.Save(bloomPath); err != nil {
			log.Printf("warning: could not save bloom filter to %s: %v", bloomPath, err)
		} else {
			log.Printf("bloom filter saved to %s (~%d songs played)", bloomPath, playedTracker.ApproxCount())
		}
		_ = db.Close()
		done <- true
	}()

	log.Printf("lofi-radio-backend  port=%d  music=%s  db=%s  bloom=%s  shuffle=%s  queue=%s",
		cfg.Port, cfg.MusicDir, cfg.DBPath, bloomPath, cfg.Shuffle.Strategy, cfg.Queue.Strategy)

	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("http server error: %s", err)
	}
	<-done

	fmt.Println("shutdown complete.")
}

func logStartupInventory(
	cfg *config.Config,
	scan *watcher.ScanSummary,
	songs []*models.Song,
	queueItems []*models.QueueItem,
	queueTarget int,
	queueAdded int,
) {
	if scan == nil {
		scan = &watcher.ScanSummary{}
	}

	totalDuration, totalSize := summarizeSongs(songs)
	log.Printf(
		"music library: dir=%q extensions=%s folder_songs=%d indexed_songs=%d newly_indexed=%d already_indexed=%d watched_subdirs=%d total_duration=%s total_size=%s",
		cfg.MusicDir,
		formatExtensions(cfg.Music.Extensions),
		scan.MusicFiles,
		len(songs),
		scan.NewlyIndexed,
		scan.AlreadyIndexed,
		scan.WatchedDirs,
		formatDuration(totalDuration),
		formatBytes(totalSize),
	)
	log.Printf(
		"queue prepared: strategy=%s shuffle=%s target_depth=%d added=%d current_depth=%d",
		cfg.Queue.Strategy,
		cfg.Shuffle.Strategy,
		queueTarget,
		queueAdded,
		len(queueItems),
	)

	if len(queueItems) == 0 {
		log.Printf("initial queue: empty")
		return
	}

	for idx, item := range queueItems {
		if item.Song == nil {
			log.Printf(
				"initial queue #%d: position=%d song_id=%s source=%s",
				idx+1,
				item.Position,
				item.SongID,
				item.Source,
			)
			continue
		}

		log.Printf(
			"initial queue #%d: position=%d source=%s title=%q artist=%q album=%q duration=%s size=%s file=%q",
			idx+1,
			item.Position,
			item.Source,
			item.Song.Title,
			item.Song.Artist,
			item.Song.Album,
			formatDuration(item.Song.DurationSecs),
			formatBytes(item.Song.SizeBytes),
			item.Song.Filename,
		)
	}
}

func summarizeSongs(songs []*models.Song) (float64, int64) {
	var totalDuration float64
	var totalSize int64
	for _, song := range songs {
		if song == nil {
			continue
		}
		totalDuration += song.DurationSecs
		totalSize += song.SizeBytes
	}
	return totalDuration, totalSize
}

func formatExtensions(extensions []string) string {
	if len(extensions) == 0 {
		return ".mp3"
	}
	return strings.Join(extensions, ",")
}

func formatDuration(seconds float64) string {
	if seconds <= 0 {
		return "unknown"
	}

	duration := time.Duration(seconds * float64(time.Second)).Round(time.Second)
	hours := int(duration.Hours())
	minutes := int(duration.Minutes()) % 60
	secs := int(duration.Seconds()) % 60

	if hours > 0 {
		return fmt.Sprintf("%dh%02dm%02ds", hours, minutes, secs)
	}
	return fmt.Sprintf("%dm%02ds", minutes, secs)
}

func formatBytes(bytes int64) string {
	if bytes <= 0 {
		return "0 B"
	}

	units := []string{"B", "KiB", "MiB", "GiB", "TiB"}
	size := float64(bytes)
	unit := 0
	for size >= 1024 && unit < len(units)-1 {
		size /= 1024
		unit++
	}
	if unit == 0 {
		return fmt.Sprintf("%d %s", bytes, units[unit])
	}
	return fmt.Sprintf("%.1f %s", size, units[unit])
}
