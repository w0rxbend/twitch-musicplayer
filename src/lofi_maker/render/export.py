from __future__ import annotations
import logging
import subprocess
import warnings
from pathlib import Path
import numpy as np
import soundfile as sf

logger = logging.getLogger(__name__)


def normalize_lufs(audio: np.ndarray, sr: int, target_lufs: float = -14.0) -> np.ndarray:
    try:
        import pyloudnorm as pyln
        meter = pyln.Meter(sr)
        # pyloudnorm needs stereo
        audio_2d = np.stack([audio, audio], axis=1) if audio.ndim == 1 else audio
        loudness = meter.integrated_loudness(audio_2d.astype(np.float64))
        if not np.isfinite(loudness):
            return audio
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            normalized = pyln.normalize.loudness(audio_2d.astype(np.float64), loudness, target_lufs)
        normalized = np.clip(normalized, -1.0, 1.0)
        return normalized[:, 0].astype(np.float32) if audio.ndim == 1 else normalized.astype(np.float32)
    except ImportError:
        # Simple peak normalisation fallback
        peak = np.abs(audio).max()
        return audio * (0.80 / peak) if peak > 0 else audio
    except Exception as exc:
        logger.warning("LUFS normalisation failed: %s", exc)
        return audio


def wav_to_mp3(wav_path: Path, mp3_path: Path, bitrate: str = "320k") -> Path:
    try:
        from pydub import AudioSegment
        AudioSegment.from_wav(str(wav_path)).export(str(mp3_path), format="mp3", bitrate=bitrate)
        return mp3_path
    except ImportError:
        pass

    result = subprocess.run(
        ["ffmpeg", "-y", "-i", str(wav_path), "-b:a", bitrate, str(mp3_path)],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.decode()}")
    return mp3_path


def export_audio(
    audio: np.ndarray,
    sr: int,
    output_stem: str | Path,
    formats: list[str] = ("mp3",),
    target_lufs: float = -14.0,
) -> dict[str, Path]:
    """
    Normalise and export audio.

    Returns a dict mapping format name to output Path.
    """
    output_stem = Path(output_stem)
    parent = output_stem.parent
    name = output_stem.name

    audio = normalize_lufs(audio, sr, target_lufs)
    audio = trim_trailing_silence(audio, sr)
    results: dict[str, Path] = {}

    need_wav = "wav" in formats or "mp3" in formats
    wav_path = parent / f"{name}.wav"

    if need_wav:
        sf.write(str(wav_path), audio, sr)
        results["wav"] = wav_path

    if "mp3" in formats:
        mp3_path = parent / f"{name}.mp3"
        wav_to_mp3(wav_path, mp3_path)
        results["mp3"] = mp3_path
        if "wav" not in formats:
            wav_path.unlink(missing_ok=True)
            results.pop("wav", None)

    return results


def trim_trailing_silence(
    audio: np.ndarray,
    sr: int,
    threshold_db: float = -45.0,
    keep_seconds: float = 0.75,
    frame_seconds: float = 0.25,
) -> np.ndarray:
    if audio.size == 0:
        return audio

    threshold = 10 ** (threshold_db / 20.0)
    mono = np.mean(audio, axis=1) if audio.ndim > 1 else audio
    mono = np.abs(mono)
    frame_len = max(1, int(sr * frame_seconds))
    active_end = None

    for start in range(0, len(mono), frame_len):
        frame = mono[start:start + frame_len]
        if frame.size == 0:
            continue
        rms = float(np.sqrt(np.mean(frame * frame)))
        if rms > threshold:
            active_end = min(len(mono), start + frame_len)

    if active_end is None:
        return audio

    end = min(len(mono), active_end + int(sr * keep_seconds))
    return audio[:end]
