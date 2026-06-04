from __future__ import annotations
import random
from dataclasses import replace
from ..core.music_context import MusicContext
from ..presets.models import LofiPreset


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
    )


def _chords_for_key(root: str, scale: str, extensions: list[int], rng: random.Random) -> list[str]:
    root_idx = _NOTES.index(root) if root in _NOTES else 0
    ext = max(extensions) if extensions else 7
    table = _MINOR_CHORDS if scale == "minor" else _MAJOR_CHORDS
    closest = min(table.keys(), key=lambda k: abs(k - ext))
    suffixes, degrees = table[closest]
    return [f"{_NOTES[(root_idx + d) % 12]}{s}" for d, s in zip(degrees, suffixes)]
