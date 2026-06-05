package main

import (
	"encoding/json"
	"log"
	"net/http"
)

// Placeholder backend for the Lofi Radio Visualizer.
// Will serve audio metadata, track queue, and stream events.

type Track struct {
	Title  string `json:"title"`
	Artist string `json:"artist"`
}

func handleNowPlaying(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(Track{
		Title:  "midnight tape — side a",
		Artist: "lofi radio · 24/7",
	})
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/now-playing", handleNowPlaying)
	mux.HandleFunc("/api/health", handleHealth)

	addr := ":8080"
	log.Printf("lofi-radio backend listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
