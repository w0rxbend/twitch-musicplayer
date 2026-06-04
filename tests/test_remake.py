import numpy as np
import pytest


def test_detect_key_returns_valid_note_and_mode():
    import librosa
    from lofi_maker.analysis.song_analyzer import detect_key

    # A 440 Hz pure tone — should produce something sensible
    y, sr = librosa.tone(440.0, sr=22050, duration=2.0), 22050
    root, mode = detect_key(y, sr)

    valid_roots = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    assert root in valid_roots
    assert mode in ("major", "minor")


def test_suggest_chords_minor_returns_four():
    from lofi_maker.analysis.song_analyzer import _suggest_chords
    chords = _suggest_chords("A", "minor")
    assert len(chords) == 4
    assert all(isinstance(c, str) and len(c) > 0 for c in chords)


def test_suggest_chords_major_returns_four():
    from lofi_maker.analysis.song_analyzer import _suggest_chords
    chords = _suggest_chords("C", "major")
    assert len(chords) == 4


def test_melody_extractor_graceful_missing_dep():
    from lofi_maker.analysis.melody_extractor import extract_melody
    result = extract_melody("/tmp/this_file_does_not_exist.mp3")
    assert result is None


def test_apply_preset_to_context_clamps_bpm():
    from lofi_maker.core.music_context import MusicContext
    from lofi_maker.core.lofi_arranger import apply_preset_to_context
    from lofi_maker.presets.loader import load_preset

    preset = load_preset("rainy_window")  # bpm_range [68, 82]
    ctx = MusicContext(bpm=120.0)  # way too fast
    result = apply_preset_to_context(ctx, preset)
    assert result.bpm <= preset.bpm_range[1]
    assert result.bpm >= preset.bpm_range[0]


def test_music_context_is_minor():
    from lofi_maker.core.music_context import MusicContext
    assert MusicContext(key="A minor").is_minor
    assert not MusicContext(key="C major").is_minor


def test_music_context_root_note():
    from lofi_maker.core.music_context import MusicContext
    assert MusicContext(key="F# minor").root_note == "F#"
