from __future__ import annotations
from fractions import Fraction
import logging
import numpy as np
from ..presets.models import EffectsConfig
from .audio_mix import ensure_2d, fit_duration, restore_shape

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


def apply_slowed_reverb_effects(
    audio: np.ndarray,
    sr: int,
    *,
    playback_rate: float,
    reverb: float,
    wet_level: float,
    lowpass_hz: float,
    fade_seconds: float,
    tail_seconds: float,
    distance: float,
    gain: float = 0.90,
    target_duration_seconds: float | None = None,
) -> np.ndarray:
    """Apply a final slowed + reverb treatment while preserving pitch-lowered playback."""
    audio = np.asarray(audio, dtype=np.float32)
    if audio.size == 0:
        return audio

    playback_rate = float(np.clip(playback_rate, 0.50, 1.0))
    reverb = float(np.clip(reverb, 0.0, 1.0))
    wet_level = float(np.clip(wet_level, 0.0, 0.75))
    distance = float(np.clip(distance, 0.0, 1.0))
    lowpass_hz = float(np.clip(lowpass_hz, 200.0, sr / 2.0 - 100.0))
    fade_seconds = max(0.0, float(fade_seconds))
    tail_seconds = max(0.0, float(tail_seconds))
    gain = max(0.0, float(gain))

    processed = _slow_playback(audio, playback_rate)
    processed = _apply_lowpass(processed, sr, lowpass_hz)
    processed = _pad_tail(processed, sr, tail_seconds)
    processed = _apply_reverb(processed, sr, reverb=reverb, wet_level=wet_level)
    processed = _apply_distance_blend(processed, distance)

    if target_duration_seconds is not None:
        processed = fit_duration(processed, sr, target_duration_seconds)

    processed = _fade_edges(processed, sr, fade_seconds=fade_seconds)
    return np.clip(processed * gain, -1.0, 1.0).astype(np.float32)


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


def _slow_playback(audio: np.ndarray, playback_rate: float) -> np.ndarray:
    if playback_rate >= 0.999:
        return audio.astype(np.float32)

    shaped = ensure_2d(audio)
    ratio = Fraction(1.0 / playback_rate).limit_denominator(1000)

    try:
        from scipy.signal import resample_poly

        stretched = resample_poly(shaped, ratio.numerator, ratio.denominator, axis=0)
    except Exception as exc:
        logger.warning("slow playback resampling failed, using linear fallback: %s", exc)
        old_positions = np.arange(shaped.shape[0], dtype=np.float32)
        new_length = max(1, int(round(shaped.shape[0] / playback_rate)))
        new_positions = np.linspace(0.0, shaped.shape[0] - 1, new_length, dtype=np.float32)
        stretched = np.empty((new_length, shaped.shape[1]), dtype=np.float32)
        for channel in range(shaped.shape[1]):
            stretched[:, channel] = np.interp(new_positions, old_positions, shaped[:, channel])

    return restore_shape(np.asarray(stretched, dtype=np.float32))


def _apply_lowpass(audio: np.ndarray, sr: int, cutoff_hz: float) -> np.ndarray:
    if cutoff_hz >= sr / 2.0 - 100.0:
        return audio

    try:
        from scipy.signal import butter, sosfilt

        sos = butter(3, cutoff_hz, btype="lowpass", fs=sr, output="sos")
        shaped = ensure_2d(audio)
        filtered = sosfilt(sos, shaped, axis=0)
        return restore_shape(filtered.astype(np.float32))
    except Exception as exc:
        logger.warning("lowpass processing failed: %s", exc)
        return audio


def _apply_reverb(audio: np.ndarray, sr: int, *, reverb: float, wet_level: float) -> np.ndarray:
    try:
        from pedalboard import Pedalboard, Reverb

        board = Pedalboard([
            Reverb(
                room_size=0.45 + reverb * 0.45,
                wet_level=wet_level,
                dry_level=max(0.42, 1.0 - wet_level * 0.85),
                damping=0.45 + reverb * 0.35,
            )
        ])
        pb_in = audio.reshape(1, -1) if audio.ndim == 1 else audio.T
        pb_out = board(pb_in, sr)
        return (pb_out[0] if audio.ndim == 1 else pb_out.T).astype(np.float32)
    except ImportError:
        logger.debug("pedalboard not installed, using delay reverb fallback")
    except Exception as exc:
        logger.warning("slowed reverb processing failed, using delay fallback: %s", exc)

    return _delay_reverb_fallback(audio, sr, reverb=reverb, wet_level=wet_level)


def _delay_reverb_fallback(audio: np.ndarray, sr: int, *, reverb: float, wet_level: float) -> np.ndarray:
    shaped = ensure_2d(audio)
    wet = np.zeros_like(shaped)
    delays = (0.087, 0.149, 0.233, 0.377, 0.611)

    for index, delay_seconds in enumerate(delays):
        delay = max(1, int(sr * delay_seconds))
        if delay >= shaped.shape[0]:
            continue
        gain = wet_level * (0.62 ** index) * (0.55 + reverb * 0.45)
        wet[delay:] += shaped[:-delay] * gain

    mixed = shaped * max(0.45, 1.0 - wet_level * 0.75) + wet
    return restore_shape(np.clip(mixed, -1.0, 1.0).astype(np.float32))


def _apply_distance_blend(audio: np.ndarray, distance: float) -> np.ndarray:
    if distance <= 0:
        return audio.astype(np.float32)

    shaped = ensure_2d(audio)
    softened = shaped * (1.0 - distance * 0.18)

    if softened.shape[1] >= 2:
        center = softened.mean(axis=1, keepdims=True)
        softened = softened * (1.0 - distance * 0.22) + center * (distance * 0.22)

    return restore_shape(softened.astype(np.float32))


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
