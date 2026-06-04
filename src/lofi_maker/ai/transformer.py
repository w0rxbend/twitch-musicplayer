from __future__ import annotations
import concurrent.futures
import logging
from typing import Optional
import pretty_midi
from ..core.music_context import MusicContext
from .rule_based import RuleBasedBackend

logger = logging.getLogger(__name__)

# Default: sander-wood/text-to-music generates ABC notation conditioned on text.
# GPT-2 scale (~117M params), fully CPU-feasible.
DEFAULT_MODEL = "sander-wood/text-to-music"
INFERENCE_TIMEOUT = 180  # seconds — CPU inference is slow


class TransformerMidiBackend:
    """
    Open-weight causal LM backend (CPU-first).

    Generates ABC notation via text-to-music conditioning, then converts
    to PrettyMIDI via music21. Falls back to RuleBasedBackend if the model
    is unavailable, fails to load, or times out.
    """

    def __init__(
        self,
        model_id: str = DEFAULT_MODEL,
        max_new_tokens: int = 1024,
        temperature: float = 0.9,
        top_p: float = 0.95,
        device: str = "cpu",
    ):
        self.model_id = model_id
        self.max_new_tokens = max_new_tokens
        self.temperature = temperature
        self.top_p = top_p
        self.device = device
        self._model = None
        self._tokenizer = None
        self._fallback = RuleBasedBackend()

    @property
    def name(self) -> str:
        return f"transformer:{self.model_id}"

    @property
    def available(self) -> bool:
        try:
            import transformers  # noqa: F401
            return True
        except ImportError:
            return False

    def _load(self) -> bool:
        if self._model is not None:
            return True
        try:
            from transformers import AutoModelForCausalLM, AutoTokenizer
            logger.info("Loading %s on %s (first run downloads the model)…", self.model_id, self.device)
            self._tokenizer = AutoTokenizer.from_pretrained(self.model_id)
            self._model = AutoModelForCausalLM.from_pretrained(self.model_id)
            self._model.to(self.device)
            self._model.eval()
            logger.info("Model ready.")
            return True
        except Exception as exc:
            logger.warning("Failed to load transformer model: %s", exc)
            return False

    def _prompt(self, ctx: MusicContext) -> str:
        """Build an ABC-header prompt the model can continue."""
        mode_char = "m" if ctx.is_minor else ""
        mood_tags = ctx.mood.replace(",", "").strip()
        # The sander-wood model was trained on prompts that start with X:1 + metadata
        return (
            f"X:1\n"
            f"T:lofi {mood_tags}\n"
            f"C:lofi-maker\n"
            f"M:4/4\n"
            f"L:1/8\n"
            f"Q:{int(ctx.bpm)}\n"
            f"K:{ctx.root_note}{mode_char}\n"
        )

    def _infer(self, prompt: str) -> str:
        inputs = self._tokenizer(prompt, return_tensors="pt").to(self.device)
        out = self._model.generate(
            **inputs,
            max_new_tokens=self.max_new_tokens,
            temperature=self.temperature,
            top_p=self.top_p,
            do_sample=True,
            pad_token_id=self._tokenizer.eos_token_id,
        )
        return self._tokenizer.decode(out[0], skip_special_tokens=True)

    def _abc_to_midi(self, abc: str, ctx: MusicContext) -> Optional[pretty_midi.PrettyMIDI]:
        try:
            import music21
            score = music21.converter.parse(abc, format="abc")
            midi = pretty_midi.PrettyMIDI(initial_tempo=ctx.bpm)
            inst = pretty_midi.Instrument(program=0, name="melody")
            beat_sec = 60.0 / ctx.bpm / 2.0  # L:1/8 = half a beat

            for elem in score.flat.notes:
                if hasattr(elem, "pitch"):
                    start = float(elem.offset) * beat_sec
                    dur = float(elem.duration.quarterLength) * beat_sec
                    inst.notes.append(pretty_midi.Note(
                        velocity=64,
                        pitch=elem.pitch.midi,
                        start=start,
                        end=start + max(0.05, dur),
                    ))

            if not inst.notes:
                return None
            midi.instruments.append(inst)
            return midi
        except Exception as exc:
            logger.debug("ABC → MIDI conversion failed: %s", exc)
            return None

    def generate_midi(self, context: MusicContext) -> pretty_midi.PrettyMIDI:
        if not self._load():
            logger.info("Falling back to rule-based backend (model unavailable).")
            return self._fallback.generate_midi(context)

        try:
            prompt = self._prompt(context)
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(self._infer, prompt)
                abc_text = future.result(timeout=INFERENCE_TIMEOUT)

            midi = self._abc_to_midi(abc_text, context)
            if midi is not None:
                return midi
            logger.info("ABC parse produced no notes, falling back.")
        except concurrent.futures.TimeoutError:
            logger.warning("Transformer timed out after %ds, falling back.", INFERENCE_TIMEOUT)
        except Exception as exc:
            logger.warning("Transformer generation error: %s, falling back.", exc)

        return self._fallback.generate_midi(context)
