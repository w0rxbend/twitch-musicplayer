from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class MusicContext:
    key: str = "A minor"
    bpm: float = 80.0
    mood: str = "warm, soft, melancholic"
    chords: list[str] = field(default_factory=lambda: ["Am9", "Fmaj7", "Cmaj7", "G13"])
    duration_seconds: float = 90.0
    density: float = 0.45
    melody_density: float = 0.25
    swing: float = 0.55
    seed: Optional[int] = None
    source_file: Optional[str] = None
    melody_notes: Optional[list[tuple[float, float, int]]] = None  # (start, end, pitch)
    energy: float = 0.5

    @property
    def is_minor(self) -> bool:
        key_lower = self.key.lower()
        return "minor" in key_lower or (len(self.key) >= 2 and self.key[1] != " " and self.key[0].islower())

    @property
    def root_note(self) -> str:
        return self.key.split()[0]

    @property
    def bars(self) -> int:
        beats = (self.bpm / 60.0) * self.duration_seconds
        return max(4, int(beats / 4))
