from __future__ import annotations
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import numpy as np


@dataclass(frozen=True)
class SegmentRequest:
    prompt: str
    duration_seconds: float = 12.0
    seed: int | None = None
    guidance_scale: float = 3.0
    temperature: float = 1.0
    top_k: int = 250


@dataclass(frozen=True)
class GeneratedAudio:
    audio: np.ndarray
    sample_rate: int
    model_id: str
    prompt: str


@runtime_checkable
class AudioSegmentBackend(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def available(self) -> bool: ...

    def generate_audio(self, request: SegmentRequest) -> GeneratedAudio: ...
