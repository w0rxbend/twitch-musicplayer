package api

import (
	"context"
	"net/http"
	"strconv"

	"lofi-radio-backend/internal/models"
)

// historyRepo abstracts the persistence layer for play history.
type historyRepo interface {
	List(ctx context.Context, limit int) ([]*models.HistoryEntry, error)
	Count(ctx context.Context) (int, error)
}

// HistoryHandler handles history resource endpoints.
type HistoryHandler struct {
	repo historyRepo
}

// NewHistoryHandler constructs a HistoryHandler.
func NewHistoryHandler(repo historyRepo) *HistoryHandler {
	return &HistoryHandler{repo: repo}
}

// List handles GET /v1/history.
// Query param: limit (default 50, max 200).
func (h *HistoryHandler) List(w http.ResponseWriter, r *http.Request) {
	const (
		defaultLimit = 50
		maxLimit     = 200
	)

	limit := defaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		if n > maxLimit {
			n = maxLimit
		}
		limit = n
	}

	entries, err := h.repo.List(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list history")
		return
	}

	total, err := h.repo.Count(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to count history")
		return
	}

	if entries == nil {
		entries = []*models.HistoryEntry{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"entries": entries,
		"total":   total,
	})
}
