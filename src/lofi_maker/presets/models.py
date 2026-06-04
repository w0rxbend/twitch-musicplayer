from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class EffectsConfig:
    vinyl_noise: float = 0.15
    tape_wow: float = 0.06
    lowpass_hz: float = 8000.0
    reverb: float = 0.20
    compression: str = "gentle"
    saturation: float = 0.08


@dataclass
class InstrumentsConfig:
    chords: str = "rhodes"
    melody: str = "felt_piano"
    bass: str = "muted_bass"
    drums: str = "soft_kit"


@dataclass
class LofiPreset:
    name: str
    style: str = "lofi"
    bpm_range: tuple[int, int] = (72, 88)
    scale_bias: str = "minor"
    swing: float = 0.55
    drum_density: float = 0.45
    melody_density: float = 0.25
    chord_extensions: list[int] = field(default_factory=lambda: [7, 9])
    mood: str = "warm, soft, melancholic"
    instruments: InstrumentsConfig = field(default_factory=InstrumentsConfig)
    effects: EffectsConfig = field(default_factory=EffectsConfig)

    @property
    def default_bpm(self) -> float:
        return (self.bpm_range[0] + self.bpm_range[1]) / 2.0
