package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"lofi-radio-backend/internal/api"
	"lofi-radio-backend/internal/config"
	"lofi-radio-backend/internal/models"
	"lofi-radio-backend/internal/played"
	"lofi-radio-backend/internal/player"
	"lofi-radio-backend/internal/queue"
	"lofi-radio-backend/internal/repository"
	"lofi-radio-backend/internal/server"
	"lofi-radio-backend/internal/watcher"
	"lofi-radio-backend/internal/websocket"
)

func main() {
	cfg := config.Load()

	// ── In-memory repositories ────────────────────────────────────────────────
	songRepo := repository.NewMemSongRepo()
	queueRepo := repository.NewMemQueueRepo(songRepo)

	// ── Played tracker (Bloom filter — the only persistence) ──────────────────
	playedTracker := played.New(10_000, 0.01)
	if err := playedTracker.Load(cfg.BloomPath); err != nil {
		log.Printf("bloom filter: starting fresh (%v)", err)
	} else {
		log.Printf("bloom filter loaded from %s (~%d songs played)", cfg.BloomPath, playedTracker.ApproxCount())
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

	// ── Player state tracker ──────────────────────────────────────────────────
	stateTracker := player.NewStateTracker()

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

	// ── HTTP API handlers ─────────────────────────────────────────────────────
	songsH := api.NewSongsHandler(songRepo, cfg.MusicDir)
	queueH := api.NewQueueHandler(queueMgr, queueRepo, hub)
	playerH := api.NewPlayerHandler(songRepo, queueRepo, hub, stateTracker)

	// ── HTTP server ───────────────────────────────────────────────────────────
	httpServer := server.New(server.Options{
		Port:         cfg.Port,
		Hub:          hub,
		Songs:        songsH,
		Queue:        queueH,
		Player:       playerH,
		BaseURL:      cfg.BaseURL,
		QueueMgr:     queueMgr,
		StateTracker: stateTracker,
	})

	// ── Bootstrap ─────────────────────────────────────────────────────────────
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
		log.Printf("warning: list songs failed: %v", err)
	}
	queueItems, err := queueMgr.ListQueue(ctx)
	if err != nil {
		log.Printf("warning: list queue failed: %v", err)
	}
	logStartupInventory(cfg, scanSummary, songs, queueItems, queueMgr.InitialQueueTarget(), queuedAdded)

	go func() {
		if err := fsWatcher.Start(ctx); err != nil {
			log.Printf("watcher stopped: %v", err)
		}
	}()

	// ── Shutdown ──────────────────────────────────────────────────────────────
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
		if err := playedTracker.Save(cfg.BloomPath); err != nil {
			log.Printf("warning: bloom filter save failed: %v", err)
		} else {
			log.Printf("bloom filter saved to %s (~%d songs played)", cfg.BloomPath, playedTracker.ApproxCount())
		}
		done <- true
	}()

	log.Printf("lofi-radio  port=%d  music=%s  bloom=%s  shuffle=%s  queue=%s",
		cfg.Port, cfg.MusicDir, cfg.BloomPath, cfg.Shuffle.Strategy, cfg.Queue.Strategy)
	log.Printf("swagger UI: http://localhost:%d/swagger", cfg.Port)

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
	queueTarget, queueAdded int,
) {
	if scan == nil {
		scan = &watcher.ScanSummary{}
	}
	totalDuration, totalSize := summarizeSongs(songs)
	log.Printf(
		"library: dir=%q ext=%s found=%d indexed=%d new=%d dirs=%d duration=%s size=%s",
		cfg.MusicDir, formatExtensions(cfg.Music.Extensions),
		scan.MusicFiles, len(songs), scan.NewlyIndexed, scan.WatchedDirs,
		formatDuration(totalDuration), formatBytes(totalSize),
	)
	log.Printf(
		"queue: strategy=%s shuffle=%s target=%d added=%d depth=%d",
		cfg.Queue.Strategy, cfg.Shuffle.Strategy,
		queueTarget, queueAdded, len(queueItems),
	)
}

func summarizeSongs(songs []*models.Song) (float64, int64) {
	var d float64
	var b int64
	for _, s := range songs {
		if s != nil {
			d += s.DurationSecs
			b += s.SizeBytes
		}
	}
	return d, b
}

func formatExtensions(ext []string) string {
	if len(ext) == 0 {
		return ".mp3"
	}
	return strings.Join(ext, ",")
}

func formatDuration(s float64) string {
	if s <= 0 {
		return "unknown"
	}
	d := time.Duration(s * float64(time.Second)).Round(time.Second)
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	sec := int(d.Seconds()) % 60
	if h > 0 {
		return fmt.Sprintf("%dh%02dm%02ds", h, m, sec)
	}
	return fmt.Sprintf("%dm%02ds", m, sec)
}

func formatBytes(b int64) string {
	if b <= 0 {
		return "0 B"
	}
	units := []string{"B", "KiB", "MiB", "GiB", "TiB"}
	sz := float64(b)
	u := 0
	for sz >= 1024 && u < len(units)-1 {
		sz /= 1024
		u++
	}
	if u == 0 {
		return fmt.Sprintf("%d B", b)
	}
	return fmt.Sprintf("%.1f %s", sz, units[u])
}
