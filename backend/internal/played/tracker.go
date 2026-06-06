package played

import (
	"os"
	"sync"

	"github.com/bits-and-blooms/bloom/v3"
)

// Tracker tracks which songs have been played using an in-memory Bloom filter.
// It is thread-safe. Bloom filters may have false positives but no false negatives —
// a song that was played will always be reported as played; an unplayed song may
// rarely be reported as played (at the configured false-positive rate).
type Tracker struct {
	mu     sync.RWMutex
	f      *bloom.BloomFilter
	cap    uint
	fpRate float64
}

// New creates a Tracker sized for n estimated items at the given false-positive rate.
func New(n uint, fpRate float64) *Tracker {
	return &Tracker{
		f:      bloom.NewWithEstimates(n, fpRate),
		cap:    n,
		fpRate: fpRate,
	}
}

// MarkPlayed records that songID has been played.
func (t *Tracker) MarkPlayed(songID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.f.AddString(songID)
}

// HasPlayed reports whether songID has been played.
func (t *Tracker) HasPlayed(songID string) bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.f.TestString(songID)
}

// Reset clears all play records, beginning a new cycle.
func (t *Tracker) Reset() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.f = bloom.NewWithEstimates(t.cap, t.fpRate)
}

// ApproxCount returns the estimated number of distinct songs played since last Reset.
func (t *Tracker) ApproxCount() uint32 {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.f.ApproximatedSize()
}

// Save persists the filter to path, overwriting any existing file.
func (t *Tracker) Save(path string) error {
	t.mu.RLock()
	defer t.mu.RUnlock()
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = t.f.WriteTo(f)
	return err
}

// Load restores the filter from path. Returns nil if path does not exist.
func (t *Tracker) Load(path string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = t.f.ReadFrom(f)
	return err
}
