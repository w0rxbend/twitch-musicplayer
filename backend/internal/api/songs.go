package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"path/filepath"

	"github.com/go-chi/chi/v5"

	"lofi-radio-backend/internal/models"
)

// songRepo abstracts the persistence layer for songs.
type songRepo interface {
	List(ctx context.Context) ([]*models.Song, error)
	GetByID(ctx context.Context, id string) (*models.Song, error)
}

// SongsHandler handles song resource endpoints.
type SongsHandler struct {
	repo     songRepo
	musicDir string
}

// NewSongsHandler constructs a SongsHandler.
func NewSongsHandler(repo songRepo, musicDir string) *SongsHandler {
	return &SongsHandler{repo: repo, musicDir: musicDir}
}

// List handles GET /v1/songs.
func (h *SongsHandler) List(w http.ResponseWriter, r *http.Request) {
	songs, err := h.repo.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list songs")
		return
	}
	if songs == nil {
		songs = []*models.Song{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"songs": songs,
		"total": len(songs),
	})
}

// Get handles GET /v1/songs/{id}.
func (h *SongsHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	song, err := h.repo.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "song not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to get song")
		return
	}
	writeJSON(w, http.StatusOK, song)
}

// StreamContent handles GET /v1/songs/{id}/content and GET /v1/songs/{id}:stream.
// http.ServeFile handles Range headers automatically, enabling streaming/seeking.
func (h *SongsHandler) StreamContent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	song, err := h.repo.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "song not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to get song")
		return
	}

	// song.Path is the absolute path stored at index time. If it is relative,
	// resolve it against the configured music directory.
	path := song.Path
	if !filepath.IsAbs(path) {
		path = filepath.Join(h.musicDir, path)
	}

	http.ServeFile(w, r, path)
}
