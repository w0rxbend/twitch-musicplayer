from __future__ import annotations
import gc
import importlib.util
import importlib.metadata
import json
import logging
from collections import namedtuple
from functools import partial
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

from .segment_backend import GeneratedAudio, SegmentRequest

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "facebook/musicgen-small"
DEFAULT_MAX_SECONDS = 30.0
DEFAULT_OPENVINO_DIR = Path("models/musicgen-small-openvino")
OPENVINO_CONVERTER_VERSION = "musicgen-openvino-v3"
OPENVINO_TRANSFORMERS_MIN = (4, 46)
OPENVINO_TRANSFORMERS_MAX_EXCLUSIVE = (4, 48)


def tokens_for_seconds(seconds: float, frame_rate: int | float = 50) -> int:
    seconds = max(1.0, min(float(seconds), DEFAULT_MAX_SECONDS))
    return int(round(seconds * float(frame_rate))) + 3


def audio_to_numpy(audio_values) -> np.ndarray:
    if hasattr(audio_values, "detach"):
        audio_values = audio_values.detach().cpu().numpy()

    audio = np.asarray(audio_values, dtype=np.float32)
    audio = np.squeeze(audio)

    if audio.ndim == 2 and audio.shape[0] <= 2 and audio.shape[1] > audio.shape[0]:
        audio = audio.T
    if audio.ndim == 2 and audio.shape[1] == 1:
        audio = audio[:, 0]

    if audio.ndim not in (1, 2):
        raise ValueError(f"Unsupported MusicGen audio shape: {audio.shape}")

    return np.clip(audio.astype(np.float32), -1.0, 1.0)


def configure_openvino_musicgen_config(config):
    config.return_dict = True
    config.decoder.torchscript = False
    config.decoder.return_dict = True
    return config


def validate_openvino_transformers_version(version: str) -> None:
    parsed = _major_minor(version)
    if not (OPENVINO_TRANSFORMERS_MIN <= parsed < OPENVINO_TRANSFORMERS_MAX_EXCLUSIVE):
        raise RuntimeError(
            "OpenVINO MusicGen conversion is supported with "
            "transformers>=4.46,<4.48 in this project. "
            f"Installed transformers is {version}. "
            "Run `pipx run uv sync --extra musicgen-openvino --extra dev`, "
            "or use `--runtime transformers`."
        )


def openvino_cache_metadata_matches(path: Path, expected: dict[str, object]) -> bool:
    try:
        actual = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    return all(actual.get(key) == value for key, value in expected.items())


def remove_openvino_cache_files(paths: list[Path]) -> None:
    for path in paths:
        path.unlink(missing_ok=True)
        path.with_suffix(".bin").unlink(missing_ok=True)


def _major_minor(version: str) -> tuple[int, int]:
    parts = version.split("+", 1)[0].split(".", 2)
    try:
        return int(parts[0]), int(parts[1])
    except (IndexError, ValueError) as exc:
        raise RuntimeError(f"Could not parse transformers version: {version}") from exc


def flatten_musicgen_cache(cache) -> tuple:
    flattened = []
    for layer_index in range(len(cache)):
        layer = cache[layer_index]
        if len(layer) == 6:
            flattened.extend((layer[0], layer[1], layer[3], layer[4]))
        elif len(layer) == 4:
            flattened.extend(layer)
        else:
            raise ValueError(f"Unsupported MusicGen cache layer length: {len(layer)}")
    return tuple(flattened)


def unflatten_musicgen_cache(flattened, encoder_decoder_cache_cls):
    flat = tuple(flattened)
    if len(flat) % 4 != 0:
        raise ValueError(f"MusicGen cache tensor count must be divisible by 4, got {len(flat)}")

    layers = []
    for index in range(0, len(flat), 4):
        layers.append((flat[index], flat[index + 1], flat[index + 2], flat[index + 3]))
    if hasattr(encoder_decoder_cache_cls, "from_legacy_cache"):
        return encoder_decoder_cache_cls.from_legacy_cache(tuple(layers))
    return encoder_decoder_cache_cls(layers)


def normalize_encodec_code_length(output_ids, target_length: int):
    target_length = int(target_length)
    if target_length <= 0:
        return output_ids

    current_length = int(output_ids.shape[-1])
    if current_length == target_length:
        return output_ids
    if current_length > target_length:
        return output_ids[..., :target_length]

    pad_length = target_length - current_length
    if hasattr(output_ids, "new_zeros"):
        import torch

        if current_length > 0:
            pad = output_ids[..., -1:].expand(*output_ids.shape[:-1], pad_length)
        else:
            pad = output_ids.new_zeros((*output_ids.shape[:-1], pad_length))
        return torch.cat([output_ids, pad], dim=-1)

    pad_source = output_ids[..., -1:] if current_length > 0 else np.zeros((*output_ids.shape[:-1], 1), dtype=output_ids.dtype)
    pad = np.repeat(pad_source, pad_length, axis=-1)
    return np.concatenate([output_ids, pad], axis=-1)


def short_exception_message(exc: BaseException) -> str:
    return str(exc).splitlines()[0] if str(exc).splitlines() else repr(exc)


class MusicGenSmallBackend:
    """
    Text-to-music audio backend for facebook/musicgen-small.

    The transformers runtime is the dependable CPU-first path. The OpenVINO
    runtime follows OpenVINO's MusicGen conversion approach and caches IR files
    in `openvino_model_dir`.
    """

    def __init__(
        self,
        model_id: str = DEFAULT_MODEL,
        runtime: str = "transformers",
        device: str = "cpu",
        openvino_model_dir: str | Path | None = None,
        openvino_device: str = "CPU",
        segment_seconds: float = 12.0,
    ):
        self.model_id = model_id
        self.runtime = runtime
        self.device = device
        self.openvino_model_dir = Path(openvino_model_dir) if openvino_model_dir else DEFAULT_OPENVINO_DIR
        self.openvino_device = openvino_device
        self.segment_seconds = max(1.0, min(float(segment_seconds), DEFAULT_MAX_SECONDS))
        self._processor = None
        self._model = None
        self._sample_rate: int | None = None
        self._frame_rate: int | None = None

    @property
    def name(self) -> str:
        return f"musicgen-small:{self.runtime}:{self.model_id}"

    @property
    def available(self) -> bool:
        if importlib.util.find_spec("transformers") is None:
            return False
        if self.runtime == "openvino":
            return importlib.util.find_spec("openvino") is not None
        return importlib.util.find_spec("torch") is not None

    def generate_audio(self, request: SegmentRequest) -> GeneratedAudio:
        if not request.prompt.strip():
            raise ValueError("MusicGen prompt cannot be empty")
        if self.runtime == "openvino":
            audio, sr = self._generate_openvino(request)
        elif self.runtime == "transformers":
            audio, sr = self._generate_transformers(request)
        else:
            raise ValueError(f"Unsupported MusicGen runtime: {self.runtime}")
        return GeneratedAudio(audio=audio, sample_rate=sr, model_id=self.model_id, prompt=request.prompt)

    def _load_transformers(self):
        if self._model is not None and self.runtime == "transformers":
            return

        try:
            import torch
            from transformers import AutoProcessor, MusicgenForConditionalGeneration
        except ImportError as exc:
            raise RuntimeError(
                "MusicGen generation requires optional dependencies. "
                "Install with `pipx run uv sync --extra musicgen` or `pip install -e '.[musicgen]'`."
            ) from exc

        logger.info("Loading %s with transformers on %s", self.model_id, self.device)
        self._processor = AutoProcessor.from_pretrained(self.model_id)
        self._model = MusicgenForConditionalGeneration.from_pretrained(
            self.model_id,
            attn_implementation="eager",
        )
        self._model.to(self.device)
        self._model.eval()
        self._sample_rate = int(self._model.config.audio_encoder.sampling_rate)
        self._frame_rate = int(self._model.config.audio_encoder.frame_rate)
        torch.set_num_threads(max(1, torch.get_num_threads()))

    def _generate_transformers(self, request: SegmentRequest) -> tuple[np.ndarray, int]:
        import torch

        self._load_transformers()
        assert self._processor is not None
        assert self._model is not None

        seconds = max(1.0, min(float(request.duration_seconds), DEFAULT_MAX_SECONDS))
        n_tokens = tokens_for_seconds(seconds, self._frame_rate or 50)
        inputs = self._processor(text=[request.prompt], padding=True, return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}

        rng_state = torch.random.get_rng_state()
        if request.seed is not None:
            torch.manual_seed(int(request.seed))

        try:
            with torch.no_grad():
                audio_values = self._model.generate(
                    **inputs,
                    do_sample=True,
                    guidance_scale=float(request.guidance_scale),
                    temperature=float(request.temperature),
                    top_k=int(request.top_k),
                    max_new_tokens=n_tokens,
                )
        finally:
            if request.seed is not None:
                torch.random.set_rng_state(rng_state)

        return audio_to_numpy(audio_values[0]), int(self._sample_rate or 32000)

    def _load_openvino(self):
        if self._model is not None and self.runtime == "openvino":
            return

        try:
            import openvino as ov
            import torch
            from transformers import AutoConfig, AutoProcessor, MusicgenForConditionalGeneration
            from transformers.cache_utils import EncoderDecoderCache
            from transformers.modeling_outputs import (
                BaseModelOutputWithPastAndCrossAttentions,
                CausalLMOutputWithCrossAttentions,
            )
        except ImportError as exc:
            raise RuntimeError(
                "OpenVINO MusicGen requires `openvino`, `torch`, and `transformers`. "
                "Install with `pipx run uv sync --extra musicgen-openvino`."
            ) from exc

        transformers_version = importlib.metadata.version("transformers")
        openvino_version = importlib.metadata.version("openvino")
        validate_openvino_transformers_version(transformers_version)

        self.openvino_model_dir.mkdir(parents=True, exist_ok=True)
        t5_ir_path = self.openvino_model_dir / "t5.xml"
        musicgen_0_ir_path = self.openvino_model_dir / "mg_0.xml"
        musicgen_ir_path = self.openvino_model_dir / "mg.xml"
        audio_decoder_ir_path = self.openvino_model_dir / "encodec.xml"
        metadata_path = self.openvino_model_dir / "metadata.json"
        ir_paths = [t5_ir_path, musicgen_0_ir_path, musicgen_ir_path, audio_decoder_ir_path]

        logger.info("Loading %s for OpenVINO conversion/runtime", self.model_id)
        processor = AutoProcessor.from_pretrained(self.model_id)
        config = configure_openvino_musicgen_config(AutoConfig.from_pretrained(self.model_id))
        model = MusicgenForConditionalGeneration.from_pretrained(
            self.model_id,
            config=config,
            attn_implementation="eager",
        )
        model.config.return_dict = True
        model.decoder.config.torchscript = False
        model.decoder.config.return_dict = True
        model.to("cpu")
        model.eval()

        sample_rate = int(model.config.audio_encoder.sampling_rate)
        frame_rate = int(model.config.audio_encoder.frame_rate)
        n_tokens = tokens_for_seconds(self.segment_seconds, frame_rate)
        inputs = processor(text=["warm ambient lofi music"], return_tensors="pt")
        expected_metadata: dict[str, object] = {
            "converter_version": OPENVINO_CONVERTER_VERSION,
            "model_id": self.model_id,
            "segment_seconds": self.segment_seconds,
            "sample_rate": sample_rate,
            "frame_rate": frame_rate,
            "max_new_tokens": n_tokens,
            "transformers_version": transformers_version,
            "openvino_version": openvino_version,
        }

        if not openvino_cache_metadata_matches(metadata_path, expected_metadata):
            logger.info("OpenVINO MusicGen cache metadata changed; rebuilding IR files")
            remove_openvino_cache_files(ir_paths)

        if not t5_ir_path.exists():
            logger.info("Converting MusicGen T5 text encoder to OpenVINO IR")
            t5_ov = ov.convert_model(model.text_encoder, example_input={"input_ids": inputs["input_ids"]})
            ov.save_model(t5_ov, t5_ir_path)
            del t5_ov
            gc.collect()

        class DecoderFirstStep(torch.nn.Module):
            def __init__(self, decoder):
                super().__init__()
                self.decoder = decoder

            def forward(self, input_ids, encoder_hidden_states, encoder_attention_mask):
                batch_size = encoder_hidden_states.shape[0]
                num_heads = self.decoder.config.num_attention_heads
                head_dim = self.decoder.config.hidden_size // num_heads
                empty_layer = (
                    torch.zeros(batch_size, num_heads, 0, head_dim, device=input_ids.device),
                    torch.zeros(batch_size, num_heads, 0, head_dim, device=input_ids.device),
                    torch.zeros(batch_size, num_heads, 0, head_dim, device=input_ids.device),
                    torch.zeros(batch_size, num_heads, 0, head_dim, device=input_ids.device),
                )
                empty_cache = unflatten_musicgen_cache(
                    empty_layer * self.decoder.config.num_hidden_layers,
                    EncoderDecoderCache,
                )
                output = self.decoder(
                    input_ids=input_ids,
                    encoder_hidden_states=encoder_hidden_states,
                    encoder_attention_mask=encoder_attention_mask,
                    past_key_values=empty_cache,
                    use_cache=True,
                    return_dict=True,
                )
                return (output.logits, *flatten_musicgen_cache(output.past_key_values))

        class DecoderCachedStep(torch.nn.Module):
            def __init__(self, decoder):
                super().__init__()
                self.decoder = decoder

            def forward(self, input_ids, encoder_hidden_states, encoder_attention_mask, *past_key_values):
                cache = unflatten_musicgen_cache(past_key_values, EncoderDecoderCache)
                output = self.decoder(
                    input_ids=input_ids,
                    encoder_hidden_states=encoder_hidden_states,
                    encoder_attention_mask=encoder_attention_mask,
                    past_key_values=cache,
                    use_cache=True,
                    return_dict=True,
                )
                return (output.logits, *flatten_musicgen_cache(output.past_key_values))

        decoder_input = {
            "input_ids": torch.ones(8, 1, dtype=torch.int64),
            "encoder_hidden_states": torch.ones(2, 12, 1024, dtype=torch.float32),
            "encoder_attention_mask": torch.ones(2, 12, dtype=torch.int64),
        }

        if not musicgen_0_ir_path.exists():
            logger.info("Converting first-step MusicGen decoder to OpenVINO IR")
            mg_ov_0_step = ov.convert_model(
                DecoderFirstStep(model.decoder),
                example_input=(
                    decoder_input["input_ids"],
                    decoder_input["encoder_hidden_states"],
                    decoder_input["encoder_attention_mask"],
                ),
            )
            ov.save_model(mg_ov_0_step, musicgen_0_ir_path)
            del mg_ov_0_step
            gc.collect()

        if not musicgen_ir_path.exists():
            logger.info("Converting cached-step MusicGen decoder to OpenVINO IR")
            past_key_values = tuple(
                tensor
                for _ in range(24)
                for tensor in (
                    torch.ones(2, 16, 1, 64, dtype=torch.float32),
                    torch.ones(2, 16, 1, 64, dtype=torch.float32),
                    torch.ones(2, 16, 12, 64, dtype=torch.float32),
                    torch.ones(2, 16, 12, 64, dtype=torch.float32),
                )
            )
            mg_ov = ov.convert_model(
                DecoderCachedStep(model.decoder),
                example_input=(
                    decoder_input["input_ids"],
                    decoder_input["encoder_hidden_states"],
                    decoder_input["encoder_attention_mask"],
                    *past_key_values,
                ),
            )
            for input_port in mg_ov.inputs[3:]:
                input_port.get_node().set_partial_shape(ov.PartialShape([-1, 16, -1, 64]))
                input_port.get_node().set_element_type(ov.Type.f32)
            mg_ov.validate_nodes_and_infer_types()
            ov.save_model(mg_ov, musicgen_ir_path)
            del mg_ov
            gc.collect()

        if not audio_decoder_ir_path.exists():
            logger.info("Converting EnCodec decoder to OpenVINO IR")

            class AudioDecoder(torch.nn.Module):
                def __init__(self, audio_encoder):
                    super().__init__()
                    self.audio_encoder = audio_encoder

                def forward(self, output_ids):
                    return self.audio_encoder.decode(output_ids, [None])

            audio_decoder_input = {"output_ids": torch.ones((1, 1, 4, n_tokens - 3), dtype=torch.int64)}
            with torch.no_grad():
                audio_decoder_ov = ov.convert_model(
                    AudioDecoder(model.audio_encoder),
                    example_input=audio_decoder_input,
                )
            ov.save_model(audio_decoder_ov, audio_decoder_ir_path)
            del audio_decoder_ov
            gc.collect()

        metadata_path.write_text(
            json.dumps(expected_metadata, indent=2)
        )

        core = ov.Core()
        device = self.openvino_device

        class TextEncoderWrapper(torch.nn.Module):
            def __init__(self, encoder_ir, config):
                super().__init__()
                self.encoder = core.compile_model(encoder_ir, device)
                self.config = config

            def forward(self, input_ids, **kwargs):
                last_hidden_state = self.encoder(input_ids)[self.encoder.outputs[0]]
                return BaseModelOutputWithPastAndCrossAttentions(
                    last_hidden_state=torch.tensor(last_hidden_state)
                )

        class MusicGenWrapper(torch.nn.Module):
            def __init__(
                self,
                music_gen_lm_0_ir,
                music_gen_lm_ir,
                config,
                num_codebooks,
                build_delay_pattern_mask,
                apply_delay_pattern_mask,
            ):
                super().__init__()
                self.music_gen_lm_0 = core.compile_model(music_gen_lm_0_ir, device)
                self.music_gen_lm = core.compile_model(music_gen_lm_ir, device)
                self.config = config
                self.num_codebooks = num_codebooks
                self.build_delay_pattern_mask = build_delay_pattern_mask
                self.apply_delay_pattern_mask = apply_delay_pattern_mask

            def forward(
                self,
                input_ids: torch.LongTensor = None,
                encoder_hidden_states: torch.FloatTensor = None,
                encoder_attention_mask: torch.LongTensor = None,
                past_key_values: Optional[Tuple[torch.FloatTensor]] = None,
                **kwargs,
            ):
                if past_key_values is None:
                    compiled = self.music_gen_lm_0
                    arguments = (input_ids, encoder_hidden_states, encoder_attention_mask)
                else:
                    compiled = self.music_gen_lm
                    flat_past_key_values = flatten_musicgen_cache(past_key_values)
                    arguments = (
                        input_ids,
                        encoder_hidden_states,
                        encoder_attention_mask,
                        *flat_past_key_values,
                    )
                output = compiled(arguments)
                past_key_values = unflatten_musicgen_cache(
                    [torch.tensor(output[compiled.outputs[i]]) for i in range(1, 97)],
                    EncoderDecoderCache,
                )
                return CausalLMOutputWithCrossAttentions(
                    logits=torch.tensor(output[compiled.outputs[0]]),
                    past_key_values=past_key_values,
                )

        class AudioDecoderWrapper(torch.nn.Module):
            def __init__(self, decoder_ir, config, torch_decoder, expected_code_length: int):
                super().__init__()
                self.decoder = core.compile_model(decoder_ir, device)
                self.config = config
                self.torch_decoder = torch_decoder
                self.expected_code_length = expected_code_length
                self.output_type = namedtuple("AudioDecoderOutput", ["audio_values"])

            def decode(self, output_ids, audio_scales):
                original_length = int(output_ids.shape[-1])
                output_ids = normalize_encodec_code_length(output_ids, self.expected_code_length)
                if original_length != self.expected_code_length:
                    logger.debug(
                        "Adjusted MusicGen EnCodec code length from %s to %s for OpenVINO decode",
                        original_length,
                        self.expected_code_length,
                    )
                try:
                    output = self.decoder(output_ids)[self.decoder.outputs[0]]
                    return self.output_type(audio_values=torch.tensor(output))
                except Exception as exc:
                    logger.warning(
                        "OpenVINO EnCodec decode failed; falling back to PyTorch decoder: %s",
                        short_exception_message(exc),
                    )
                    with torch.no_grad():
                        return self.torch_decoder.decode(output_ids, audio_scales)

        text_encoder_ov = TextEncoderWrapper(t5_ir_path, model.text_encoder.config)
        musicgen_decoder_ov = MusicGenWrapper(
            musicgen_0_ir_path,
            musicgen_ir_path,
            model.decoder.config,
            model.decoder.num_codebooks,
            model.decoder.build_delay_pattern_mask,
            model.decoder.apply_delay_pattern_mask,
        )
        audio_encoder_ov = AudioDecoderWrapper(
            audio_decoder_ir_path,
            model.audio_encoder.config,
            model.audio_encoder,
            expected_code_length=n_tokens - 3,
        )

        del model.text_encoder
        del model.decoder
        gc.collect()

        model.text_encoder = text_encoder_ov
        model.decoder = musicgen_decoder_ov
        model.audio_encoder = audio_encoder_ov
        model.prepare_inputs_for_generation = partial(_prepare_musicgen_inputs_for_generation, model)

        self._processor = processor
        self._model = model
        self._sample_rate = sample_rate
        self._frame_rate = frame_rate

    def _generate_openvino(self, request: SegmentRequest) -> tuple[np.ndarray, int]:
        import torch

        self._load_openvino()
        assert self._processor is not None
        assert self._model is not None

        n_tokens = tokens_for_seconds(self.segment_seconds, self._frame_rate or 50)
        inputs = self._processor(text=[request.prompt], padding=True, return_tensors="pt")

        rng_state = torch.random.get_rng_state()
        if request.seed is not None:
            torch.manual_seed(int(request.seed))

        try:
            with torch.no_grad():
                audio_values = self._model.generate(
                    **inputs,
                    do_sample=True,
                    guidance_scale=float(request.guidance_scale),
                    temperature=float(request.temperature),
                    top_k=int(request.top_k),
                    max_new_tokens=n_tokens,
                )
        finally:
            if request.seed is not None:
                torch.random.set_rng_state(rng_state)

        audio = audio_to_numpy(audio_values[0])
        requested_samples = int(max(1.0, float(request.duration_seconds)) * int(self._sample_rate or 32000))
        return audio[:requested_samples], int(self._sample_rate or 32000)


def _prepare_musicgen_inputs_for_generation(
    self,
    decoder_input_ids,
    past_key_values=None,
    attention_mask=None,
    head_mask=None,
    decoder_attention_mask=None,
    decoder_head_mask=None,
    cross_attn_head_mask=None,
    use_cache=None,
    encoder_outputs=None,
    decoder_delay_pattern_mask=None,
    guidance_scale=None,
    **kwargs,
):
    if decoder_delay_pattern_mask is None:
        decoder_input_ids, decoder_delay_pattern_mask = self.decoder.build_delay_pattern_mask(
            decoder_input_ids,
            self.generation_config.pad_token_id,
            max_length=self.generation_config.max_length,
        )
    decoder_input_ids = self.decoder.apply_delay_pattern_mask(decoder_input_ids, decoder_delay_pattern_mask)
    if guidance_scale is not None and guidance_scale > 1:
        decoder_input_ids = decoder_input_ids.repeat((2, 1))
        if decoder_attention_mask is not None:
            decoder_attention_mask = decoder_attention_mask.repeat((2, 1))
    if past_key_values is not None:
        decoder_input_ids = decoder_input_ids[:, -1:]
    return {
        "input_ids": None,
        "encoder_outputs": encoder_outputs,
        "past_key_values": past_key_values,
        "decoder_input_ids": decoder_input_ids,
        "attention_mask": attention_mask,
        "decoder_attention_mask": decoder_attention_mask,
        "head_mask": head_mask,
        "decoder_head_mask": decoder_head_mask,
        "cross_attn_head_mask": cross_attn_head_mask,
        "use_cache": use_cache,
    }
