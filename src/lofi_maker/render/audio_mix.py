from __future__ import annotations
import numpy as np


def ensure_2d(audio: np.ndarray) -> np.ndarray:
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 1:
        return audio[:, None]
    if audio.ndim != 2:
        raise ValueError(f"Unsupported audio shape: {audio.shape}")
    return audio


def restore_shape(audio: np.ndarray) -> np.ndarray:
    if audio.ndim == 2 and audio.shape[1] == 1:
        return audio[:, 0]
    return audio


def crossfade_segments(segments: list[np.ndarray], sr: int, crossfade_seconds: float = 1.0) -> np.ndarray:
    if not segments:
        return np.zeros(0, dtype=np.float32)

    mixed = ensure_2d(segments[0])
    for segment in segments[1:]:
        next_segment = ensure_2d(segment)
        if mixed.shape[1] != next_segment.shape[1]:
            channels = max(mixed.shape[1], next_segment.shape[1])
            mixed = _match_channels(mixed, channels)
            next_segment = _match_channels(next_segment, channels)

        fade_len = min(
            int(sr * max(0.0, crossfade_seconds)),
            mixed.shape[0],
            next_segment.shape[0],
        )
        if fade_len <= 1:
            mixed = np.concatenate([mixed, next_segment], axis=0)
            continue

        fade_out = np.linspace(1.0, 0.0, fade_len, dtype=np.float32)[:, None]
        fade_in = np.linspace(0.0, 1.0, fade_len, dtype=np.float32)[:, None]
        overlap = mixed[-fade_len:] * fade_out + next_segment[:fade_len] * fade_in
        mixed = np.concatenate([mixed[:-fade_len], overlap, next_segment[fade_len:]], axis=0)

    return restore_shape(np.clip(mixed, -1.0, 1.0).astype(np.float32))


def fit_duration(audio: np.ndarray, sr: int, duration_seconds: float) -> np.ndarray:
    target = max(1, int(sr * max(0.0, duration_seconds)))
    shaped = ensure_2d(audio)
    if shaped.shape[0] > target:
        shaped = shaped[:target]
    elif shaped.shape[0] < target:
        pad = np.zeros((target - shaped.shape[0], shaped.shape[1]), dtype=np.float32)
        shaped = np.concatenate([shaped, pad], axis=0)
    return restore_shape(shaped.astype(np.float32))


def _match_channels(audio: np.ndarray, channels: int) -> np.ndarray:
    if audio.shape[1] == channels:
        return audio
    if audio.shape[1] == 1:
        return np.repeat(audio, channels, axis=1)
    return audio[:, :channels]
