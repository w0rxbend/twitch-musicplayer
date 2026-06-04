from __future__ import annotations
import random
from dataclasses import replace
from ..core.music_context import MusicContext
from ..presets.models import EffectsConfig, LofiPreset


_NOTES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]

_MINOR_CHORDS = {
    7:  (["m7",  "maj7", "m7",  "7"  ], [0, 3, 7, 10]),
    9:  (["m9",  "maj9", "m7",  "9"  ], [0, 3, 7, 10]),
    11: (["m11", "maj9", "m9",  "9"  ], [0, 3, 7, 10]),
}
_MAJOR_CHORDS = {
    7:  (["maj7", "maj7", "m7",  "7"  ], [0, 5, 9, 7]),
    9:  (["maj9", "maj9", "m9",  "9"  ], [0, 5, 9, 7]),
    11: (["maj9", "maj9", "m11", "9"  ], [0, 5, 9, 7]),
}


def from_preset(preset: LofiPreset, duration_seconds: float = 90.0, seed: int | None = None) -> MusicContext:
    rng = random.Random(seed)

    bpm = round(rng.uniform(*preset.bpm_range), 1)

    if preset.scale_bias == "minor":
        roots = ["A", "D", "E", "G", "C", "F"]
        key_word = "minor"
    else:
        roots = ["C", "F", "G", "D", "A", "E"]
        key_word = "major"

    root = rng.choice(roots)
    key = f"{root} {key_word}"
    chords = _chords_for_key(root, preset.scale_bias, preset.chord_extensions, rng)

    return MusicContext(
        key=key,
        bpm=bpm,
        mood=preset.mood,
        chords=chords,
        duration_seconds=duration_seconds,
        density=preset.drum_density,
        melody_density=preset.melody_density,
        swing=preset.swing,
        seed=seed,
        chord_instrument=preset.instruments.chords,
        melody_instrument=preset.instruments.melody,
        bass_instrument=preset.instruments.bass,
        drums_instrument=preset.instruments.drums,
    )


def apply_preset_to_context(ctx: MusicContext, preset: LofiPreset) -> MusicContext:
    """Clamp / blend an analysed MusicContext with preset parameters."""
    bpm_min, bpm_max = preset.bpm_range
    bpm = max(float(bpm_min), min(float(bpm_max), ctx.bpm))

    return replace(
        ctx,
        bpm=bpm,
        swing=preset.swing,
        density=preset.drum_density,
        melody_density=preset.melody_density,
        chord_instrument=preset.instruments.chords,
        melody_instrument=preset.instruments.melody,
        bass_instrument=preset.instruments.bass,
        drums_instrument=preset.instruments.drums,
    )


def build_cover_context(ctx: MusicContext) -> MusicContext:
    """Transform source-song analysis into a new instrumental cover context."""
    rng = random.Random(ctx.seed)
    energy = max(0.0, min(1.0, ctx.energy))
    density = round(max(0.18, min(0.52, 0.18 + energy * 0.42)), 2)
    swing = round(0.53 + rng.random() * 0.04, 2)
    melody_notes = _fit_melody_to_cover(ctx)

    return replace(
        ctx,
        mood=f"{ctx.mood}, instrumental cover, reimagined lofi arrangement",
        density=density,
        melody_density=0.0 if melody_notes else 0.12,
        swing=swing,
        melody_notes=melody_notes,
        chord_instrument="rhodes" if energy >= 0.35 else "pad",
        melody_instrument="felt_piano",
        bass_instrument="upright_bass" if energy < 0.6 else "muted_bass",
        drums_instrument="soft_kit",
    )


def cover_effects_from_context(ctx: MusicContext) -> EffectsConfig:
    energy = max(0.0, min(1.0, ctx.energy))
    return EffectsConfig(
        vinyl_noise=round(0.06 + (1.0 - energy) * 0.08, 3),
        tape_wow=round(0.035 + (1.0 - energy) * 0.035, 3),
        lowpass_hz=round(6200 + energy * 2200, 1),
        reverb=round(0.22 + (1.0 - energy) * 0.12, 3),
        compression="gentle",
        saturation=round(0.05 + energy * 0.04, 3),
    )


def _fit_melody_to_cover(ctx: MusicContext) -> list[tuple[float, float, int]] | None:
    if not ctx.melody_notes:
        return None

    source_bpm = ctx.source_bpm or ctx.bpm
    ratio = source_bpm / ctx.bpm if ctx.bpm > 0 else 1.0
    fitted: list[tuple[float, float, int]] = []

    for start, end, pitch in ctx.melody_notes:
        new_start = max(0.0, float(start) * ratio)
        new_end = max(new_start + 0.08, float(end) * ratio)
        if new_start >= ctx.duration_seconds:
            continue
        fitted.append((new_start, min(new_end, ctx.duration_seconds), int(pitch)))

    return fitted or None


def _chords_for_key(root: str, scale: str, extensions: list[int], rng: random.Random) -> list[str]:
    root_idx = _NOTES.index(root) if root in _NOTES else 0
    ext = max(extensions) if extensions else 7
    table = _MINOR_CHORDS if scale == "minor" else _MAJOR_CHORDS
    closest = min(table.keys(), key=lambda k: abs(k - ext))
    suffixes, degrees = table[closest]
    return [f"{_NOTES[(root_idx + d) % 12]}{s}" for d, s in zip(degrees, suffixes)]
