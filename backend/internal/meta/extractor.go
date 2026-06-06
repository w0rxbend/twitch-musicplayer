package meta

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	id3 "github.com/bogem/id3v2/v2"
)

// Info holds extracted metadata from an audio file.
type Info struct {
	Title        string
	Artist       string
	Album        string
	DurationSecs float64
}

// Extract reads ID3v2 tags from path, returning best-effort metadata.
// Falls back to filename-based title and file-size-based duration when tags are absent.
func Extract(path string) Info {
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	info := Info{Title: name}

	tag, err := id3.Open(path, id3.Options{Parse: true})
	if err != nil {
		return withDurationEstimate(info, path)
	}
	defer tag.Close()

	if t := strings.TrimSpace(tag.Title()); t != "" {
		info.Title = t
	}
	info.Artist = strings.TrimSpace(tag.Artist())
	info.Album = strings.TrimSpace(tag.Album())

	// TLEN frame encodes duration in milliseconds.
	if frames := tag.GetFrames(tag.CommonID("Length")); len(frames) > 0 {
		if tf, ok := frames[0].(id3.TextFrame); ok {
			if ms, err := strconv.ParseFloat(strings.TrimSpace(tf.Text), 64); err == nil && ms > 0 {
				info.DurationSecs = ms / 1000.0
				return info
			}
		}
	}

	return withDurationEstimate(info, path)
}

// withDurationEstimate fills DurationSecs using a rough 128 kbps CBR assumption.
func withDurationEstimate(info Info, path string) Info {
	if stat, err := os.Stat(path); err == nil && stat.Size() > 0 {
		info.DurationSecs = float64(stat.Size()) / 16_000 // 128 kbps = 16 000 B/s
	}
	return info
}
