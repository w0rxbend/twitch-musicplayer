package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"lofi-radio-backend/internal/api"
	"lofi-radio-backend/internal/config"
	"lofi-radio-backend/internal/database"
	"lofi-radio-backend/internal/models"
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
	historyRepo := repository.NewHistoryRepo(sqlDB)
	queueRepo := repository.NewQueueRepo(sqlDB)

	// ── Queue manager ─────────────────────────────────────────────────────────
	queueMgr := queue.New(songRepo, historyRepo, queueRepo)

	// ── WebSocket hub ─────────────────────────────────────────────────────────
	hub := websocket.NewHub()
	go hub.Run()

	// ── File watcher ──────────────────────────────────────────────────────────
	fsWatcher, err := watcher.New(cfg.MusicDir, songRepo, queueMgr, func(_ *models.Song) {
		// Broadcast queue_updated notification to all connected clients.
		msg, encErr := websocket.Encode(websocket.MsgQueueUpdated, websocket.QueueUpdatedPayload{
			Reason: "new_file",
		})
		if encErr == nil {
			hub.Broadcast(msg)
		}
	})
	if err != nil {
		log.Fatalf("watcher init failed: %v", err)
	}

	// ── HTTP API handlers ────────────────────────────────────────────────────
	songsH := api.NewSongsHandler(songRepo, cfg.MusicDir)
	queueH := api.NewQueueHandler(queueMgr, queueRepo)
	historyH := api.NewHistoryHandler(historyRepo)
	playerH := api.NewPlayerHandler(songRepo, queueRepo, historyRepo, hub)

	// ── HTTP server ───────────────────────────────────────────────────────────
	httpServer := server.New(server.Options{
		Port:     cfg.Port,
		DB:       db,
		Hub:      hub,
		Songs:    songsH,
		Queue:    queueH,
		History:  historyH,
		Player:   playerH,
		BaseURL:  cfg.BaseURL,
		QueueMgr: queueMgr,
	})

	// ── Background tasks ──────────────────────────────────────────────────────
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Scan existing music files before starting the watcher loop.
	if err := fsWatcher.ScanExisting(ctx); err != nil {
		log.Printf("warning: scan existing failed: %v", err)
	}
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
		_ = db.Close()
		done <- true
	}()

	log.Printf("lofi-radio-backend listening on :%d  music=%s  db=%s",
		cfg.Port, cfg.MusicDir, cfg.DBPath)

	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("http server error: %s", err)
	}
	<-done

	fmt.Println("shutdown complete.")
}
