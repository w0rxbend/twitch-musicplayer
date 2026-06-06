package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"lofi-radio-backend/internal/api"
	"lofi-radio-backend/internal/database"
	"lofi-radio-backend/internal/websocket"
)

// Options holds all dependencies for the HTTP server.
type Options struct {
	Port     int
	DB       database.Service
	Hub      *websocket.Hub
	Songs    *api.SongsHandler
	Queue    *api.QueueHandler
	History  *api.HistoryHandler
	Player   *api.PlayerHandler
	BaseURL  string
	QueueMgr websocket.QueueManager
}

// New wires up the Chi router and returns a configured *http.Server.
func New(opts Options) *http.Server {
	return &http.Server{
		Addr:         fmt.Sprintf(":%d", opts.Port),
		Handler:      buildRoutes(opts),
		IdleTimeout:  time.Minute,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
	}
}

func buildRoutes(opts Options) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"https://*", "http://*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		health := opts.DB.Health()
		status := http.StatusOK
		if health["status"] == "down" {
			status = http.StatusServiceUnavailable
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(health) //nolint:errcheck
	})

	r.Get("/ws", func(w http.ResponseWriter, r *http.Request) {
		websocket.ServeWS(opts.Hub, opts.QueueMgr, opts.BaseURL, w, r)
	})

	api.RegisterRoutes(r, opts.Songs, opts.Queue, opts.History, opts.Player)

	return r
}
