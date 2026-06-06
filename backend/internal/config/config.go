package config

import (
	"log"
	"os"
	"strconv"

	_ "github.com/joho/godotenv/autoload"
)

type Config struct {
	Port     int
	DBPath   string
	MusicDir string
	BaseURL  string
}

func Load() *Config {
	port := 8080
	if v := os.Getenv("PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			port = n
		}
	}

	dbPath := os.Getenv("BLUEPRINT_DB_URL")
	if dbPath == "" {
		dbPath = "./lofi-radio.db"
	}

	musicDir := os.Getenv("MUSIC_DIR")
	if musicDir == "" {
		musicDir = "./music"
	}

	baseURL := os.Getenv("BASE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:" + strconv.Itoa(port)
	}

	cfg := &Config{
		Port:     port,
		DBPath:   dbPath,
		MusicDir: musicDir,
		BaseURL:  baseURL,
	}

	if err := os.MkdirAll(musicDir, 0o755); err != nil {
		log.Printf("warning: could not create music dir %s: %v", musicDir, err)
	}

	return cfg
}
