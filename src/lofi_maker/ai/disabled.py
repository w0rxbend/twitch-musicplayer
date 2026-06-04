from __future__ import annotations
import pretty_midi
from ..core.music_context import MusicContext


class DisabledBackend:
    @property
    def name(self) -> str:
        return "disabled"

    @property
    def available(self) -> bool:
        return False

    def generate_midi(self, context: MusicContext) -> pretty_midi.PrettyMIDI:
        raise RuntimeError("AI backend is disabled")
