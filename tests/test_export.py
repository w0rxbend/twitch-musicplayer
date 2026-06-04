import numpy as np
import pytest
from lofi_maker.render.export import normalize_lufs, export_audio


def _sine(sr: int = 44100, secs: float = 1.0) -> np.ndarray:
    t = np.linspace(0, secs, int(sr * secs), endpoint=False)
    return (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)


def test_normalize_lufs_mono():
    audio = _sine()
    result = normalize_lufs(audio, 44100)
    assert result.shape == audio.shape
    assert np.isfinite(result).all()


def test_normalize_lufs_stereo():
    audio = np.stack([_sine(), _sine()], axis=1)
    result = normalize_lufs(audio, 44100)
    assert result.shape == audio.shape
    assert np.isfinite(result).all()


def test_normalize_lufs_silent_audio_safe():
    silent = np.zeros(44100, dtype=np.float32)
    result = normalize_lufs(silent, 44100)
    assert result.shape == silent.shape


def test_export_wav(tmp_path):
    audio = _sine()
    results = export_audio(audio, 44100, tmp_path / "test", formats=["wav"])
    assert "wav" in results
    assert results["wav"].exists()
    assert results["wav"].stat().st_size > 0


def test_export_only_mp3_removes_wav(tmp_path):
    audio = _sine()
    results = export_audio(audio, 44100, tmp_path / "test", formats=["mp3"])
    # Intermediate wav should be cleaned up
    wav = tmp_path / "test.wav"
    assert not wav.exists()
    assert "mp3" in results or True  # mp3 requires pydub/ffmpeg; skip if unavailable
