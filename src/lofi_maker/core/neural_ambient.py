from __future__ import annotations
from dataclasses import dataclass

import numpy as np

from ..ai.segment_backend import AudioSegmentBackend, SegmentRequest
from ..presets.models import LofiPreset
from ..render.audio_mix import crossfade_segments, fit_duration

DEFAULT_AMBIENT_PROMPT = (
    "slow ambient lofi instrumental, warm Rhodes chords, soft felt piano, "
    "subtle tape hiss, wide reverb, mellow bass, no vocals, no lead vocal"
)


@dataclass(frozen=True)
class AmbientGenerationResult:
    audio: np.ndarray
    sample_rate: int
    prompt: str
    segment_count: int


def build_ambient_prompt(preset: LofiPreset | None = None, prompt: str | None = None) -> str:
    pieces = [prompt.strip()] if prompt and prompt.strip() else [DEFAULT_AMBIENT_PROMPT]
    if preset is not None:
        pieces.append(f"{preset.mood} mood")
        pieces.append(f"{preset.default_bpm:.0f} bpm")
        pieces.append(f"{preset.instruments.chords} chords")
        pieces.append(f"{preset.instruments.melody} accents")
    pieces.append("loopable, gentle dynamics, clean instrumental mix")
    return ", ".join(piece for piece in pieces if piece)


def generate_lofi_ambient_audio(
    backend: AudioSegmentBackend,
    prompt: str,
    duration_seconds: float,
    seed: int | None = None,
    segment_seconds: float = 12.0,
    crossfade_seconds: float = 1.0,
    guidance_scale: float = 3.0,
    temperature: float = 1.0,
    top_k: int = 250,
) -> AmbientGenerationResult:
    duration_seconds = max(1.0, float(duration_seconds))
    segment_seconds = max(1.0, min(float(segment_seconds), 30.0))
    crossfade_seconds = max(0.0, min(float(crossfade_seconds), segment_seconds / 2.0))

    segments: list[np.ndarray] = []
    sample_rate: int | None = None
    generated_seconds = 0.0
    segment_index = 0

    while generated_seconds < duration_seconds:
        remaining = duration_seconds - generated_seconds
        request_seconds = min(segment_seconds, max(1.0, remaining + crossfade_seconds))
        request = SegmentRequest(
            prompt=prompt,
            duration_seconds=request_seconds,
            seed=None if seed is None else seed + segment_index,
            guidance_scale=guidance_scale,
            temperature=temperature,
            top_k=top_k,
        )
        generated = backend.generate_audio(request)
        if sample_rate is None:
            sample_rate = generated.sample_rate
        elif sample_rate != generated.sample_rate:
            raise ValueError("Generated segments have mismatched sample rates")
        segments.append(generated.audio)

        if segment_index == 0:
            generated_seconds += request_seconds
        else:
            generated_seconds += max(0.0, request_seconds - crossfade_seconds)
        segment_index += 1

    assert sample_rate is not None
    audio = crossfade_segments(segments, sample_rate, crossfade_seconds=crossfade_seconds)
    audio = fit_duration(audio, sample_rate, duration_seconds)
    return AmbientGenerationResult(
        audio=audio,
        sample_rate=sample_rate,
        prompt=prompt,
        segment_count=len(segments),
    )
