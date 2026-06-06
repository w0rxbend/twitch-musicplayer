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

// playerHistoryRepo provides the total history count for the player state snapshot.
type playerHistoryRepo interface {
	Count(ctx context.Context) (int, error)
}

// PlayerHandler handles player state endpoints.
type PlayerHandler struct {
	songRepo    playerSongRepo
	queueRepo   playerQueueRepo
	historyRepo playerHistoryRepo
	hub         interface{ ClientCount() int }
}

// NewPlayerHandler constructs a PlayerHandler.
func NewPlayerHandler(
	s playerSongRepo,
	q playerQueueRepo,
	h playerHistoryRepo,
	hub interface{ ClientCount() int },
) *PlayerHandler {
	return &PlayerHandler{
		songRepo:    s,
		queueRepo:   q,
		historyRepo: h,
		hub:         hub,
	}
}

// State handles GET /v1/player.
// It assembles a PlayerState snapshot from the various repositories.
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

	historyCount, err := h.historyRepo.Count(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to count history")
		return
	}

	state := models.PlayerState{
		TotalSongs:   totalSongs,
		QueueLength:  queueLength,
		HistoryCount: historyCount,
	}

	writeJSON(w, http.StatusOK, state)
}
