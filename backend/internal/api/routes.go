package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// RegisterRoutes mounts all v1 resource routes onto the provided chi router.
func RegisterRoutes(r chi.Router, songs *SongsHandler, queue *QueueHandler, player *PlayerHandler) {
	r.Route("/v1", func(r chi.Router) {
		// Songs
		r.Get("/songs", songs.List)
		r.Get("/songs/{id}", songs.Get)
		r.Get("/songs/{id}/content", songs.StreamContent)
		r.Get("/songs/{id}:stream", songs.StreamContent)

		// Queue
		r.Get("/queue", queue.List)
		r.Post("/queue", queue.Add)
		r.Delete("/queue/{id}", queue.Remove)
		r.Post("/queue:skip", queue.Skip)
		r.Post("/queue:clear", queue.Clear)

		// Player
		r.Get("/player", player.State)
	})
}

// RegisterRoutesHTTP is a convenience wrapper for use with a plain http.Handler.
func RegisterRoutesHTTP(songs *SongsHandler, queue *QueueHandler, player *PlayerHandler) http.Handler {
	r := chi.NewRouter()
	RegisterRoutes(r, songs, queue, player)
	return r
}
