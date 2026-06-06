package api

import (
	"context"
	"net/http"

	"lofi-radio-backend/internal/models"
)

// playerSongRepo provides the total song count for the player state snapshot.
type playerSongRepo interface {
	Count(ctx context.Context) (int, error)
}

// playerQueueRepo provides the current queue length for the player state snapshot.
type playerQueueRepo interface {
	Count(ctx context.Context) (int, error)
}

// PlayerHandler handles player state endpoints.
type PlayerHandler struct {
	songRepo  playerSongRepo
	queueRepo playerQueueRepo
	hub       interface{ ClientCount() int }
}

// NewPlayerHandler constructs a PlayerHandler.
func NewPlayerHandler(
	s playerSongRepo,
	q playerQueueRepo,
	hub interface{ ClientCount() int },
) *PlayerHandler {
	return &PlayerHandler{
		songRepo:  s,
		queueRepo: q,
		hub:       hub,
	}
}

// State handles GET /v1/player.
func (h *PlayerHandler) State(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	totalSongs, err := h.songRepo.Count(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to count songs")
		return
	}

	queueLength, err := h.queueRepo.Count(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to count queue")
		return
	}

	state := models.PlayerState{
		TotalSongs:  totalSongs,
		QueueLength: queueLength,
	}

	writeJSON(w, http.StatusOK, state)
}
