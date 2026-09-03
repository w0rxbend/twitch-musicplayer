package queue

import (
	"context"
	"testing"

	"lofi-radio-backend/internal/models"
	"lofi-radio-backend/internal/played"
	"lofi-radio-backend/internal/repository"
)

// buildManager wires a Manager over real in-memory repositories and a bloom
// tracker, seeded with the given songs.
func buildManager(t *testing.T, cfg ManagerConfig, songs []*models.Song) *Manager {
	t.Helper()
	ctx := context.Background()
	songRepo := repository.NewMemSongRepo()
	for _, s := range songs {
		if err := songRepo.Create(ctx, s); err != nil {
			t.Fatalf("seed song %s: %v", s.ID, err)
		}
	}
	queueRepo := repository.NewMemQueueRepo(songRepo)
	tracker := played.New(1000, 0.01)
	return New(songRepo, tracker, queueRepo, cfg)
}

func song(id, title, artist string) *models.Song {
	return &models.Song{ID: id, Filename: id + ".mp3", Title: title, Artist: artist}
}

// autoRefillCfg selects auto-refill with no look-ahead so NextSong purely
// auto-selects without pre-filling the queue.
func autoRefillCfg(strategy ShuffleStrategy) ManagerConfig {
	return ManagerConfig{
		Shuffle: ShuffleConfig{Strategy: strategy},
		Fill:    FillConfig{Strategy: FillAutoRefill, MinAhead: 0},
	}
}

// TestNoSameArtistBackToBack verifies the diversity rule: with a two-song,
// two-artist library the rotation must strictly alternate artists after the
// first (random) pick, for every non-random strategy.
func TestNoSameArtistBackToBack(t *testing.T) {
	strategies := []ShuffleStrategy{ShuffleRoundRobin, ShuffleWeightedHistory, ShuffleLeastPlayed}
	for _, strat := range strategies {
		t.Run(string(strat), func(t *testing.T) {
			ctx := context.Background()
			m := buildManager(t, autoRefillCfg(strat), []*models.Song{
				song("x1", "X One", "Artist X"),
				song("y1", "Y One", "Artist Y"),
			})
			var prevArtist string
			for i := 0; i < 20; i++ {
				s, err := m.NextSong(ctx)
				if err != nil {
					t.Fatalf("NextSong[%d]: %v", i, err)
				}
				if i > 0 && s.Artist == prevArtist {
					t.Fatalf("pick %d repeated artist %q (an alternative existed)", i, s.Artist)
				}
				prevArtist = s.Artist
			}
		})
	}
}

// TestFullCycleCoverage verifies that non-random strategies play every song
// exactly once before repeating any (the bloom-filter cycle).
func TestFullCycleCoverage(t *testing.T) {
	strategies := []ShuffleStrategy{ShuffleRoundRobin, ShuffleWeightedHistory, ShuffleLeastPlayed}
	for _, strat := range strategies {
		t.Run(string(strat), func(t *testing.T) {
			ctx := context.Background()
			songs := []*models.Song{
				song("a", "A", "AA"), song("b", "B", "BB"),
				song("c", "C", "CC"), song("d", "D", "DD"),
				song("e", "E", "EE"),
			}
			m := buildManager(t, autoRefillCfg(strat), songs)
			seen := map[string]bool{}
			for i := 0; i < len(songs); i++ {
				s, err := m.NextSong(ctx)
				if err != nil {
					t.Fatalf("NextSong[%d]: %v", i, err)
				}
				if seen[s.ID] {
					t.Fatalf("song %s repeated before the cycle completed", s.ID)
				}
				seen[s.ID] = true
			}
			if len(seen) != len(songs) {
				t.Fatalf("expected %d distinct songs, got %d", len(songs), len(seen))
			}
		})
	}
}

// TestWeightedHistoryFavoursStaleSongs checks that weighted_history biases away
// from recently played songs. With a single artist (diversity disabled) and a
// large library, the song that has gone longest without a play should, across
// many trials, be picked far more often than the just-played one.
func TestWeightedHistoryFavoursStaleSongs(t *testing.T) {
	ctx := context.Background()
	// Single artist so artist-adjacency never fires; isolates recency weighting.
	songs := []*models.Song{
		song("s1", "S1", "One"), song("s2", "S2", "One"),
		song("s3", "S3", "One"), song("s4", "S4", "One"),
		song("s5", "S5", "One"), song("s6", "S6", "One"),
	}
	m := buildManager(t, ManagerConfig{
		Shuffle: ShuffleConfig{Strategy: ShuffleWeightedHistory, RecentWindow: 3},
		Fill:    FillConfig{Strategy: FillManualOnly},
	}, songs)

	// Prime history: s1 is the most recent, s6 has never been played.
	m.recordPlay(song("s6", "S6", "One")) // stale (oldest / outside window)
	m.recordPlay(song("s3", "S3", "One"))
	m.recordPlay(song("s2", "S2", "One"))
	m.recordPlay(song("s1", "S1", "One")) // most recent

	all, _ := m.songs.List(ctx)
	counts := map[string]int{}
	const trials = 4000
	for i := 0; i < trials; i++ {
		s := m.weightedPick(all, len(all))
		counts[s.ID]++
	}
	// s1 is most recent (heavily down-weighted); s5 was never played (full weight).
	if counts["s5"] <= counts["s1"] {
		t.Fatalf("expected stale song s5 (%d) to beat recent s1 (%d)", counts["s5"], counts["s1"])
	}
}

// TestNextSongEmptyLibrary ensures a graceful error when nothing is indexed.
func TestNextSongEmptyLibrary(t *testing.T) {
	ctx := context.Background()
	m := buildManager(t, autoRefillCfg(ShuffleRoundRobin), nil)
	if _, err := m.NextSong(ctx); err == nil {
		t.Fatal("expected error selecting from empty library")
	}
}
