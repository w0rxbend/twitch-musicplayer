package api

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"lofi-radio-backend/internal/models"
)

// queueManager covers the high-level queue operations exposed by queue.Manager.
type queueManager interface {
	AddToQueue(ctx context.Context, songID string, source models.QueueSource) error
	ListQueue(ctx context.Context) ([]*models.QueueItem, error)
	SkipCurrent(ctx context.Context) (*models.Song, *models.HistoryEntry, error)
	ClearQueue(ctx context.Context) error
}

// queueRepo covers low-level queue store operations (e.g. Remove by ID).
type queueRepo interface {
	Remove(ctx context.Context, id string) error
}

// playSongResponse is the response body returned by the Skip endpoint.
type playSongResponse struct {
	Song         *models.Song         `json:"song"`
	HistoryEntry *models.HistoryEntry `json:"history_entry,omitempty"`
}

// addToQueueRequest is the request body for POST /v1/queue.
type addToQueueRequest struct {
	SongID string `json:"song_id"`
}

// QueueHandler handles queue resource endpoints.
type QueueHandler struct {
	mgr  queueManager
	repo queueRepo
}

// NewQueueHandler constructs a QueueHandler.
func NewQueueHandler(mgr queueManager, repo queueRepo) *QueueHandler {
	return &QueueHandler{mgr: mgr, repo: repo}
}

// List handles GET /v1/queue.
func (h *QueueHandler) List(w http.ResponseWriter, r *http.Request) {
	items, err := h.mgr.ListQueue(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list queue")
		return
	}
	if items == nil {
		items = []*models.QueueItem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items,
		"total": len(items),
	})
}

// Add handles POST /v1/queue.
func (h *QueueHandler) Add(w http.ResponseWriter, r *http.Request) {
	var req addToQueueRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.SongID == "" {
		writeError(w, http.StatusBadRequest, "song_id is required")
		return
	}

	if err := h.mgr.AddToQueue(r.Context(), req.SongID, models.QueueSourceManual); err != nil {
		// queue.Manager wraps a "not found" error — treat it as 404.
		writeError(w, http.StatusNotFound, "song not found")
		return
	}

	// Return the newly queued item by fetching the updated queue tail.
	items, err := h.mgr.ListQueue(r.Context())
	if err != nil || len(items) == 0 {
		// Enqueue succeeded but we can't read back — return minimal 201.
		w.WriteHeader(http.StatusCreated)
		return
	}

	// The last item in the queue is the one we just added.
	writeJSON(w, http.StatusCreated, items[len(items)-1])
}

// Remove handles DELETE /v1/queue/{id}.
func (h *QueueHandler) Remove(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.repo.Remove(r.Context(), id); err != nil {
		writeError(w, http.StatusNotFound, "queue item not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Skip handles POST /v1/queue:skip.
func (h *QueueHandler) Skip(w http.ResponseWriter, r *http.Request) {
	song, entry, err := h.mgr.SkipCurrent(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to skip current song")
		return
	}
	writeJSON(w, http.StatusOK, playSongResponse{
		Song:         song,
		HistoryEntry: entry,
	})
}

// Clear handles POST /v1/queue:clear.
func (h *QueueHandler) Clear(w http.ResponseWriter, r *http.Request) {
	if err := h.mgr.ClearQueue(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to clear queue")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "queue cleared"})
}
