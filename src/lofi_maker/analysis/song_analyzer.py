from __future__ import annotations
import numpy as np
import librosa
from pathlib import Path
from ..core.music_context import MusicContext


_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler key profiles
_KEY_PROFILES = {
    "major": [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    "minor": [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
}


def detect_key(y: np.ndarray, sr: int) -> tuple[str, str]:
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    best_root, best_mode, best_score = 0, "major", -np.inf
    for mode, profile in _KEY_PROFILES.items():
        for shift in range(12):
            score = float(np.corrcoef(np.roll(chroma, -shift), profile)[0, 1])
            if score > best_score:
                best_score, best_root, best_mode = score, shift, mode
    return _NOTE_NAMES[best_root], best_mode


def analyze_song(
    path: str | Path,
    duration_seconds: float = 90.0,
    seed: int | None = None,
) -> MusicContext:
    y, sr = librosa.load(str(path), duration=60.0, mono=True)

    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    source_bpm = float(np.median(tempo)) if hasattr(tempo, "__len__") else float(tempo)
    source_bpm = max(60.0, min(160.0, source_bpm))
    # Lofi typically runs a few BPM slower — subtle humanisation
    bpm = round(max(60.0, min(140.0, source_bpm * 0.88)), 1)

    root, mode = detect_key(y, sr)
    key = f"{root} {'minor' if mode == 'minor' else 'major'}"

    rms = float(np.mean(librosa.feature.rms(y=y)))
    energy = min(1.0, rms * 12.0)

    return MusicContext(
        key=key,
        bpm=bpm,
        mood=_mood_from_energy(energy, mode),
        chords=_suggest_chords(root, mode),
        duration_seconds=duration_seconds,
        density=round(max(0.2, min(0.6, energy * 0.65)), 2),
        melody_density=0.25,
        swing=0.55,
        seed=seed,
        source_file=str(path),
        source_bpm=round(source_bpm, 1),
        energy=energy,
    )


def _suggest_chords(root: str, mode: str) -> list[str]:
    idx = _NOTE_NAMES.index(root) if root in _NOTE_NAMES else 0
    if mode == "minor":
        degrees, suffixes = [0, 3, 7, 10], ["m9", "maj7", "m7", "7"]
    else:
        degrees, suffixes = [0, 5, 9, 7], ["maj9", "maj7", "m7", "9"]
    return [f"{_NOTE_NAMES[(idx + d) % 12]}{s}" for d, s in zip(degrees, suffixes)]


def _mood_from_energy(energy: float, mode: str) -> str:
    if mode == "minor":
        if energy < 0.3:
            return "soft, melancholic, late night"
        if energy < 0.6:
            return "warm, nostalgic, introspective"
        return "emotive, moody, atmospheric"
    else:
        if energy < 0.3:
            return "peaceful, dreamy, soft"
        if energy < 0.6:
            return "warm, uplifting, gentle"
        return "bright, energetic, positive"
