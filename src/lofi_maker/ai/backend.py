from __future__ import annotations
from typing import Protocol, runtime_checkable
import pretty_midi
from ..core.music_context import MusicContext


@runtime_checkable
class MusicAIBackend(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def available(self) -> bool: ...

    def generate_midi(self, context: MusicContext) -> pretty_midi.PrettyMIDI: ...
