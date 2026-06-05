import numpy as np
import soundfile as sf

from lofi_maker.core.chiptune import (
    ChiptuneChord,
    ChiptuneNote,
    ChiptunePercussionHit,
    _infer_chord_from_chroma,
    generate_chiptune_cover,
    synthesize_chiptune_cover,
)


def test_synthesize_chiptune_cover_returns_stereo_audio():
    chords = [
        ChiptuneChord(0.0, 2.0, 0, "major"),
        ChiptuneChord(2.0, 4.0, 5, "major"),
    ]
    melody = [
        ChiptuneNote(0.0, 0.4, 64),
        ChiptuneNote(0.5, 0.9, 67),
        ChiptuneNote(1.0, 1.4, 72),
    ]
    beat_times = np.arange(0.0, 4.0, 0.5, dtype=np.float32)

    audio = synthesize_chiptune_cover(
        chord_events=chords,
        melody_events=melody,
        beat_times=beat_times,
        bpm=120.0,
        duration_seconds=4.0,
        sample_rate=8_000,
        chip_rate=4_000,
        bit_depth=8,
        seed=7,
    )

    assert audio.shape == (32_000, 2)
    assert audio.dtype == np.float32
    assert np.isfinite(audio).all()
    assert np.max(np.abs(audio)) > 0.05


def test_generate_chiptune_cover_uses_supplied_melody_notes(tmp_path):
    sr = 22_050
    duration = 2.0
    t = np.linspace(0.0, duration, int(sr * duration), endpoint=False)
    y = 0.25 * np.sin(2 * np.pi * 440.0 * t)
    y[:: sr // 2] += 0.5

    input_path = tmp_path / "source.wav"
    sf.write(input_path, y.astype(np.float32), sr)

    result = generate_chiptune_cover(
        input_path,
        duration_seconds=duration,
        melody_notes=[(0.0, 0.45, 69), (0.5, 0.9, 71), (1.0, 1.4, 72)],
        sample_rate=8_000,
        chip_rate=4_000,
        bit_depth=8,
        seed=3,
    )

    assert result.audio.shape == (16_000, 2)
    assert result.melody_note_count == 3
    assert result.chord_count >= 1
    assert result.beat_count >= 1
    assert np.isfinite(result.audio).all()


def test_chord_inference_uses_template_not_loudest_bin():
    chroma = np.zeros(12, dtype=np.float32)
    chroma[0] = 0.38
    chroma[4] = 0.34
    chroma[7] = 1.0

    root, quality, confidence = _infer_chord_from_chroma(chroma, "C major", "major")

    assert root == 0
    assert quality == "major"
    assert confidence > 0.35


def test_synthesize_chiptune_cover_accepts_detected_bass_and_percussion():
    audio = synthesize_chiptune_cover(
        chord_events=[ChiptuneChord(0.0, 1.0, 0, "major")],
        melody_events=[ChiptuneNote(0.0, 0.3, 72)],
        bass_events=[ChiptuneNote(0.0, 0.45, 36, 0.8), ChiptuneNote(0.5, 0.8, 43, 0.7)],
        percussion_events=[
            ChiptunePercussionHit(0.0, "kick", 0.9),
            ChiptunePercussionHit(0.25, "hat", 0.5),
            ChiptunePercussionHit(0.5, "snare", 0.7),
        ],
        beat_times=np.arange(0.0, 1.0, 0.5, dtype=np.float32),
        bpm=120.0,
        duration_seconds=1.0,
        sample_rate=8_000,
        chip_rate=4_000,
        bit_depth=8,
        seed=11,
    )

    assert audio.shape == (8_000, 2)
    assert np.isfinite(audio).all()
    assert np.max(np.abs(audio)) > 0.05


def test_cli_exposes_cover_chiptune_command():
    from click.testing import CliRunner
    from lofi_maker.cli import cli

    result = CliRunner().invoke(cli, ["cover-chiptune", "--help"])

    assert result.exit_code == 0
    assert "Create an 8-bit chiptune cover" in result.output
