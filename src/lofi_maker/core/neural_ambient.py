from __future__ import annotations
from dataclasses import dataclass
import re
import secrets

import numpy as np

from ..ai.segment_backend import AudioSegmentBackend, SegmentRequest
from ..presets.models import LofiPreset
from ..render.audio_mix import crossfade_segments, fit_duration

DEFAULT_AMBIENT_PROMPT = (
    "slow ambient lofi instrumental, warm Rhodes chords, soft felt piano, "
    "subtle tape hiss, wide reverb, mellow bass, no vocals, no lead vocal"
)

SLOWED_REVERB_AMBIENT_PROMPT = (
    "original sad ambient instrumental, slowed down, drenched in long reverb, "
    "soft distant piano, blurred pads, sparse low bass, no vocals, no sampled vocals"
)


@dataclass(frozen=True)
class AmbientGenerationResult:
    audio: np.ndarray
    sample_rate: int
    prompt: str
    segment_count: int


@dataclass(frozen=True)
class SlowedReverbPreset:
    name: str
    title: str
    prompt: str
    playback_rate: float
    reverb: float
    wet_level: float
    lowpass_hz: float
    fade_seconds: float
    tail_seconds: float
    distance: float
    gain: float = 0.90


SLOWED_REVERB_PRESETS: tuple[SlowedReverbPreset, ...] = (
    SlowedReverbPreset(
        name="fading",
        title="fading (slowed + reverb)",
        prompt="long fading pad swells, dissolving piano fragments, slow minor harmony",
        playback_rate=0.84,
        reverb=0.72,
        wet_level=0.36,
        lowpass_hz=5200.0,
        fade_seconds=6.0,
        tail_seconds=5.0,
        distance=0.25,
        gain=0.90,
    ),
    SlowedReverbPreset(
        name="in_the_distance",
        title="in the distance (slowed + reverb)",
        prompt="muffled piano far away, music through walls, hazy room tone, distant reverb tail",
        playback_rate=0.82,
        reverb=0.86,
        wet_level=0.46,
        lowpass_hz=3600.0,
        fade_seconds=4.5,
        tail_seconds=7.0,
        distance=0.75,
        gain=0.82,
    ),
    SlowedReverbPreset(
        name="moving_apart",
        title="moving apart (slowed + reverb)",
        prompt="separating piano echoes, widening empty space, lonely suspended chords",
        playback_rate=0.80,
        reverb=0.80,
        wet_level=0.42,
        lowpass_hz=4500.0,
        fade_seconds=5.5,
        tail_seconds=6.5,
        distance=0.55,
        gain=0.86,
    ),
    SlowedReverbPreset(
        name="my_last_day_on_earth",
        title="my last day on earth (slowed + reverb)",
        prompt="fragile final-day atmosphere, mournful piano, huge empty sky reverb, soft sub bass",
        playback_rate=0.78,
        reverb=0.90,
        wet_level=0.50,
        lowpass_hz=4000.0,
        fade_seconds=7.0,
        tail_seconds=8.0,
        distance=0.60,
        gain=0.82,
    ),
    SlowedReverbPreset(
        name="nothing_matters",
        title="nothing matters (slowed + reverb)",
        prompt="numb late-night ambience, minimal notes, dark pads, washed-out melancholic texture",
        playback_rate=0.76,
        reverb=0.88,
        wet_level=0.52,
        lowpass_hz=3300.0,
        fade_seconds=8.0,
        tail_seconds=8.5,
        distance=0.70,
        gain=0.78,
    ),
    SlowedReverbPreset(
        name="roadtrips",
        title="roadtrips (slowed + reverb)",
        prompt="night-drive ambience, soft moving chords, rain on glass, warm horizon bass",
        playback_rate=0.86,
        reverb=0.62,
        wet_level=0.34,
        lowpass_hz=5800.0,
        fade_seconds=5.0,
        tail_seconds=4.5,
        distance=0.25,
        gain=0.92,
    ),
    SlowedReverbPreset(
        name="something_else",
        title="something else (slowed + reverb)",
        prompt="strange dreamy ambience, detuned pads, half-remembered piano, soft tape drift",
        playback_rate=0.83,
        reverb=0.78,
        wet_level=0.40,
        lowpass_hz=4700.0,
        fade_seconds=5.0,
        tail_seconds=6.0,
        distance=0.45,
        gain=0.88,
    ),
    SlowedReverbPreset(
        name="the_hardest_part",
        title="the hardest part (slowed + reverb)",
        prompt="heartbroken piano motif, heavy reverb bloom, dark suspended chords, slow release",
        playback_rate=0.79,
        reverb=0.84,
        wet_level=0.48,
        lowpass_hz=3900.0,
        fade_seconds=6.5,
        tail_seconds=7.5,
        distance=0.65,
        gain=0.80,
    ),
)


def list_slowed_reverb_presets() -> tuple[SlowedReverbPreset, ...]:
    return SLOWED_REVERB_PRESETS


def get_slowed_reverb_preset(name: str) -> SlowedReverbPreset:
    normalized = _normalize_slowed_reverb_name(name)
    for preset in SLOWED_REVERB_PRESETS:
        if normalized in {_normalize_slowed_reverb_name(preset.name), _normalize_slowed_reverb_name(preset.title)}:
            return preset
    valid = ", ".join(preset.name for preset in SLOWED_REVERB_PRESETS)
    raise ValueError(f"Unknown slowed + reverb preset: {name!r}. Expected one of: {valid}")


def random_slowed_reverb_preset() -> SlowedReverbPreset:
    return secrets.choice(SLOWED_REVERB_PRESETS)


def slowed_reverb_source_duration(
    target_duration_seconds: float,
    preset: SlowedReverbPreset | None,
) -> float:
    target_duration_seconds = max(1.0, float(target_duration_seconds))
    if preset is None:
        return target_duration_seconds
    return max(1.0, target_duration_seconds * preset.playback_rate)


def build_ambient_prompt(
    preset: LofiPreset | None = None,
    prompt: str | None = None,
    slowed_reverb_preset: SlowedReverbPreset | None = None,
) -> str:
    pieces = [prompt.strip()] if prompt and prompt.strip() else [DEFAULT_AMBIENT_PROMPT]
    if preset is not None:
        pieces.append(f"{preset.mood} mood")
        pieces.append(f"{preset.default_bpm:.0f} bpm")
        pieces.append(f"{preset.instruments.chords} chords")
        pieces.append(f"{preset.instruments.melody} accents")
    if slowed_reverb_preset is not None:
        pieces.append(SLOWED_REVERB_AMBIENT_PROMPT)
        pieces.append(slowed_reverb_preset.prompt)
    pieces.append("loopable, gentle dynamics, clean instrumental mix")
    return ", ".join(piece for piece in pieces if piece)


def _normalize_slowed_reverb_name(name: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", name.strip().lower())
    normalized = re.sub(r"_slowed_reverb$", "", normalized)
    return normalized.strip("_")


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
