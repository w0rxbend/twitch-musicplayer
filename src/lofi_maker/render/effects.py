from __future__ import annotations
import logging
import numpy as np
from ..presets.models import EffectsConfig

logger = logging.getLogger(__name__)


def apply_lofi_effects(audio: np.ndarray, sr: int, config: EffectsConfig) -> np.ndarray:
    audio = audio.astype(np.float32)
    audio = _pad_tail(audio, sr, seconds=max(0.45, min(2.5, 0.6 + config.reverb * 3.0)))

    # --- pedalboard chain ---------------------------------------------------
    try:
        from pedalboard import Pedalboard, LowpassFilter, Reverb, Compressor, Distortion

        board = Pedalboard()

        if config.lowpass_hz < 20_000:
            board.append(LowpassFilter(cutoff_frequency_hz=float(config.lowpass_hz)))

        if config.compression not in ("none", ""):
            ratio = 2.5 if config.compression == "gentle" else 4.0
            threshold = -22.0 if config.compression == "gentle" else -14.0
            board.append(Compressor(threshold_db=threshold, ratio=ratio, attack_ms=8.0, release_ms=120.0))

        if config.saturation > 0:
            board.append(Distortion(drive_db=config.saturation * 8.0))

        if config.reverb > 0:
            board.append(Reverb(
                room_size=config.reverb * 0.45,
                wet_level=config.reverb * 0.28,
                dry_level=0.82,
                damping=0.6,
            ))

        # pedalboard expects (channels, samples) float32
        if audio.ndim == 1:
            pb_in = audio.reshape(1, -1)
        else:
            pb_in = audio.T

        pb_out = board(pb_in, sr)
        audio = pb_out[0] if audio.ndim == 1 else pb_out.T
    except ImportError:
        logger.debug("pedalboard not installed, skipping DSP chain")
    except Exception as exc:
        logger.warning("pedalboard processing failed: %s", exc)

    # --- analogue texture ---------------------------------------------------
    if config.vinyl_noise > 0:
        audio = _vinyl_noise(audio, config.vinyl_noise)

    if config.tape_wow > 0:
        audio = _tape_wow(audio, sr, config.tape_wow)

    audio = _trim_trailing_silence(audio, sr)
    return _fade_edges(audio, sr)


def _vinyl_noise(audio: np.ndarray, amount: float) -> np.ndarray:
    noise = np.random.normal(0, amount * 0.003, audio.shape).astype(np.float32)
    # Occasional crackle spikes
    crackle = np.where(
        np.random.random(audio.shape) < amount * 0.0015,
        np.random.normal(0, amount * 0.06, audio.shape).astype(np.float32),
        0.0,
    )
    return audio + noise + crackle


def _pad_tail(audio: np.ndarray, sr: int, seconds: float) -> np.ndarray:
    tail_len = int(sr * seconds)
    if tail_len <= 0:
        return audio

    if audio.ndim == 1:
        tail = np.zeros(tail_len, dtype=audio.dtype)
    else:
        tail = np.zeros((tail_len, audio.shape[1]), dtype=audio.dtype)
    return np.concatenate([audio, tail], axis=0)


def _trim_trailing_silence(
    audio: np.ndarray,
    sr: int,
    threshold: float = 1e-4,
    keep_seconds: float = 0.75,
) -> np.ndarray:
    if audio.size == 0:
        return audio

    levels = np.max(np.abs(audio), axis=1) if audio.ndim > 1 else np.abs(audio)
    active = np.flatnonzero(levels > threshold)
    if active.size == 0:
        return audio

    keep = int(sr * keep_seconds)
    end = min(len(levels), int(active[-1]) + keep)
    return audio[:end]


def _tape_wow(audio: np.ndarray, sr: int, amount: float) -> np.ndarray:
    n = audio.shape[0] if audio.ndim > 1 else len(audio)
    t = np.arange(n, dtype=np.float32) / sr
    # Slow pitch warble (0.3–0.7 Hz)
    modulation = np.cumsum(1.0 + amount * 0.008 * np.sin(2 * np.pi * 0.45 * t).astype(np.float32))
    modulation = (modulation / modulation[-1]) * (n - 1)
    indices = np.clip(modulation.astype(np.int32), 0, n - 1)
    if audio.ndim == 1:
        return audio[indices]
    return audio[indices]


def _fade_edges(audio: np.ndarray, sr: int, fade_seconds: float = 0.08) -> np.ndarray:
    n = audio.shape[0] if audio.ndim > 1 else len(audio)
    fade_len = min(int(sr * fade_seconds), n // 2)
    if fade_len <= 1:
        return audio

    shaped = audio.copy()
    fade_in = np.linspace(0.0, 1.0, fade_len, dtype=np.float32)
    fade_out = np.linspace(1.0, 0.0, fade_len, dtype=np.float32)

    if shaped.ndim == 1:
        shaped[:fade_len] *= fade_in
        shaped[-fade_len:] *= fade_out
    else:
        shaped[:fade_len, :] *= fade_in[:, None]
        shaped[-fade_len:, :] *= fade_out[:, None]
    return shaped
