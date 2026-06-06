package config

import (
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/BurntSushi/toml"
	_ "github.com/joho/godotenv/autoload"
)

// Config holds the complete runtime configuration for the service.
type Config struct {
	Server  ServerConfig  `toml:"server"`
	Music   MusicConfig   `toml:"music"`
	Bloom   BloomConfig   `toml:"bloom"`
	Shuffle ShuffleConfig `toml:"shuffle"`
	Queue   QueueConfig   `toml:"queue"`

	// Flat accessors populated by Load.
	Port      int
	MusicDir  string
	BloomPath string
	BaseURL   string
}

type ServerConfig struct {
	Port    int    `toml:"port"`
	BaseURL string `toml:"base_url"`
}

type MusicConfig struct {
	Dir        string   `toml:"dir"`
	Extensions []string `toml:"extensions"`
}

type BloomConfig struct {
	// Path is where the played-songs Bloom filter is persisted between restarts.
	Path string `toml:"path"`
}

type ShuffleConfig struct {
	// Strategy: random | weighted_history | round_robin | least_played
	Strategy     string `toml:"strategy"`
	RecentWindow int    `toml:"recent_window"`
}

type QueueConfig struct {
	// Strategy: manual_only | auto_refill | preload
	Strategy    string `toml:"strategy"`
	MinAhead    int    `toml:"min_ahead"`
	PreloadSize int    `toml:"preload_size"`
}

func defaults() *Config {
	return &Config{
		Server:  ServerConfig{Port: 8080, BaseURL: "http://localhost:8080"},
		Music:   MusicConfig{Dir: "./music", Extensions: []string{".mp3", ".MP3"}},
		Bloom:   BloomConfig{Path: "./lofi-radio.bloom"},
		Shuffle: ShuffleConfig{Strategy: "round_robin", RecentWindow: 0},
		Queue:   QueueConfig{Strategy: "auto_refill", MinAhead: 1, PreloadSize: 3},
	}
}

// Load reads config.toml (or the path in LOFI_CONFIG), then overlays env vars.
func Load() *Config {
	cfg := defaults()

	configPath := os.Getenv("LOFI_CONFIG")
	if configPath == "" {
		configPath = "config.toml"
	}

	if _, err := os.Stat(configPath); err == nil {
		if _, err := toml.DecodeFile(configPath, cfg); err != nil {
			log.Printf("warning: could not parse %s: %v", configPath, err)
		} else {
			log.Printf("config loaded from %s", configPath)
		}
	}

	// Env vars take precedence (container-friendly overrides).
	if v := os.Getenv("PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.Server.Port = n
		}
	}
	if v := os.Getenv("MUSIC_DIR"); v != "" {
		cfg.Music.Dir = v
	}
	if v := os.Getenv("BASE_URL"); v != "" {
		cfg.Server.BaseURL = v
	}
	if v := os.Getenv("BLOOM_PATH"); v != "" {
		cfg.Bloom.Path = v
	}

	cfg.Music.Dir = expandHomePath(cfg.Music.Dir)
	cfg.Bloom.Path = expandHomePath(cfg.Bloom.Path)

	// Populate flat fields.
	cfg.Port = cfg.Server.Port
	cfg.MusicDir = cfg.Music.Dir
	cfg.BloomPath = cfg.Bloom.Path
	cfg.BaseURL = cfg.Server.BaseURL

	if err := os.MkdirAll(cfg.Music.Dir, 0o755); err != nil {
		log.Printf("warning: could not create music dir %s: %v", cfg.Music.Dir, err)
	}

	return cfg
}

func expandHomePath(path string) string {
	if path == "" || path == "~" {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			if path == "~" {
				return home
			}
		}
		return path
	}

	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			return filepath.Join(home, path[2:])
		}
	}

	return path
}
