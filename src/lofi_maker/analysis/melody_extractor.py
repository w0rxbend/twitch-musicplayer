from __future__ import annotations
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def extract_melody(path: str | Path) -> Optional[list[tuple[float, float, int]]]:
    """Return [(start_sec, end_sec, midi_pitch), ...] or None if unavailable."""
    try:
        from basic_pitch.inference import predict
        from basic_pitch import ICASSP_2022_MODEL_PATH

        _, midi_data, _ = predict(str(path), ICASSP_2022_MODEL_PATH)
        if not midi_data.instruments:
            return None

        notes = [
            (n.start, n.end, n.pitch)
            for n in midi_data.instruments[0].notes
        ]
        return notes or None
    except ImportError:
        logger.info("Basic Pitch not available; using librosa pYIN melody fallback")
        return _extract_melody_with_librosa(path)
    except Exception as exc:
        logger.warning("Basic Pitch melody extraction failed: %s; trying librosa fallback", exc)
        return _extract_melody_with_librosa(path)


def _extract_melody_with_librosa(path: str | Path) -> Optional[list[tuple[float, float, int]]]:
    try:
        import librosa
        import numpy as np

        y, sr = librosa.load(str(path), mono=True)
        if y.size == 0:
            return None

        f0, voiced_flag, _ = librosa.pyin(
            y,
            fmin=librosa.note_to_hz("C2"),
            fmax=librosa.note_to_hz("C7"),
            sr=sr,
        )
        if f0 is None or voiced_flag is None:
            return None

        times = librosa.times_like(f0, sr=sr)
        pitches = np.rint(librosa.hz_to_midi(f0)).astype(float)
        notes: list[tuple[float, float, int]] = []
        current_start: float | None = None
        current_pitch: int | None = None
        frame_step = float(times[1] - times[0]) if len(times) > 1 else 0.05

        for time, pitch_value, voiced in zip(times, pitches, voiced_flag):
            pitch = int(pitch_value) if voiced and not np.isnan(pitch_value) else None
            if pitch is None:
                if current_start is not None and current_pitch is not None:
                    _append_note(notes, current_start, float(time), current_pitch)
                current_start = None
                current_pitch = None
                continue

            pitch = max(36, min(96, pitch))
            if current_pitch is None:
                current_start = float(time)
                current_pitch = pitch
            elif abs(pitch - current_pitch) <= 1:
                current_pitch = round((current_pitch + pitch) / 2)
            else:
                _append_note(notes, current_start or 0.0, float(time), current_pitch)
                current_start = float(time)
                current_pitch = pitch

        if current_start is not None and current_pitch is not None:
            _append_note(notes, current_start, float(times[-1] + frame_step), current_pitch)

        return _merge_short_gaps(notes, max_gap=frame_step * 2.0) or None
    except FileNotFoundError:
        return None
    except Exception as exc:
        logger.warning("librosa melody fallback failed: %s", exc)
        return None


def _append_note(notes: list[tuple[float, float, int]], start: float, end: float, pitch: int) -> None:
    if end - start >= 0.08:
        notes.append((start, max(end, start + 0.08), pitch))


def _merge_short_gaps(
    notes: list[tuple[float, float, int]],
    max_gap: float,
) -> list[tuple[float, float, int]]:
    merged: list[tuple[float, float, int]] = []
    for start, end, pitch in notes:
        if merged:
            prev_start, prev_end, prev_pitch = merged[-1]
            if pitch == prev_pitch and start <= prev_end + max_gap:
                merged[-1] = (prev_start, max(prev_end, end), prev_pitch)
                continue
        merged.append((start, end, pitch))
    return merged
