from __future__ import annotations
import tempfile
from pathlib import Path
from typing import Optional

import soundfile as sf
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .analysis.melody_extractor import extract_melody
from .analysis.song_analyzer import analyze_song
from .ai.musicgen import MusicGenSmallBackend
from .core.chiptune import generate_chiptune_cover
from .core.neural_ambient import (
    build_ambient_prompt,
    generate_lofi_ambient_audio,
    get_slowed_reverb_preset,
    random_slowed_reverb_preset,
    slowed_reverb_source_duration,
)
from .core.lofi_arranger import build_cover_context, cover_effects_from_context, from_preset
from .presets.loader import list_presets, load_preset
from .render.effects import apply_lofi_effects, apply_slowed_reverb_effects
from .render.export import export_audio
from .render.soundfont import find_soundfont, midi_to_wav

app = FastAPI(title="lofi-maker", version="0.1.0")

_backend_cache: dict[str, object] = {}


def _get_backend(use_transformer: bool = False, model_id: Optional[str] = None):
    if use_transformer:
        from .ai.transformer import TransformerMidiBackend
        key = f"transformer:{model_id or 'default'}"
        if key not in _backend_cache:
            _backend_cache[key] = TransformerMidiBackend(
                model_id=model_id or "sander-wood/text-to-music"
            )
        return _backend_cache[key]
    from .ai.rule_based import RuleBasedBackend
    return RuleBasedBackend()


def _get_audio_backend(
    runtime: str = "transformers",
    model_id: str = "facebook/musicgen-small",
    device: str = "cpu",
    openvino_device: str = "CPU",
    openvino_model_dir: Optional[str] = None,
    segment_seconds: float = 12.0,
):
    key = (
        f"audio:{runtime}:{model_id}:{device}:{openvino_device}:"
        f"{openvino_model_dir or ''}:{segment_seconds:.2f}"
    )
    if key not in _backend_cache:
        _backend_cache[key] = MusicGenSmallBackend(
            model_id=model_id,
            runtime=runtime,
            device=device,
            openvino_device=openvino_device,
            openvino_model_dir=openvino_model_dir,
            segment_seconds=segment_seconds,
        )
    return _backend_cache[key]


# ------------------------------------------------------------------ #
# Schemas
# ------------------------------------------------------------------ #

class GeneratePresetRequest(BaseModel):
    preset: str
    duration_seconds: float = 90.0
    output: list[str] = ["mp3"]
    seed: Optional[int] = None
    use_transformer: bool = False
    model_id: Optional[str] = None


class GenerateAmbientRequest(BaseModel):
    prompt: Optional[str] = None
    preset: str = "ambient_lofi"
    slowed_reverb_preset: Optional[str] = None
    duration_seconds: float = 12.0
    segment_seconds: float = 12.0
    crossfade_seconds: float = 1.0
    output: list[str] = ["mp3"]
    seed: Optional[int] = None
    model_id: str = "facebook/musicgen-small"
    runtime: str = "transformers"
    device: str = "cpu"
    openvino_device: str = "CPU"
    openvino_model_dir: Optional[str] = None
    guidance_scale: float = 3.0
    temperature: float = 1.0
    top_k: int = 250


# ------------------------------------------------------------------ #
# Routes
# ------------------------------------------------------------------ #

@app.get("/presets")
def get_presets():
    return {"presets": list_presets()}


@app.post("/generate/preset")
async def generate_preset(req: GeneratePresetRequest):
    try:
        preset = load_preset(req.preset)
    except FileNotFoundError:
        raise HTTPException(404, f"Preset '{req.preset}' not found")

    ctx = from_preset(preset, duration_seconds=req.duration_seconds, seed=req.seed)
    backend = _get_backend(req.use_transformer, req.model_id)
    midi = backend.generate_midi(ctx)

    return _render_and_respond(midi, preset.effects, req.preset, req.output)


@app.post("/generate/ambient")
async def generate_ambient(req: GenerateAmbientRequest):
    if req.runtime not in {"transformers", "openvino"}:
        raise HTTPException(400, "runtime must be 'transformers' or 'openvino'")
    if req.duration_seconds <= 0:
        raise HTTPException(400, "duration_seconds must be positive")

    try:
        preset = load_preset(req.preset)
    except FileNotFoundError:
        raise HTTPException(404, f"Preset '{req.preset}' not found")

    try:
        slowed_reverb = _resolve_api_slowed_reverb_preset(req.slowed_reverb_preset)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    backend = _get_audio_backend(
        runtime=req.runtime,
        model_id=req.model_id,
        device=req.device,
        openvino_device=req.openvino_device,
        openvino_model_dir=req.openvino_model_dir,
        segment_seconds=req.segment_seconds,
    )
    if not backend.available:
        raise HTTPException(503, "MusicGen dependencies are not installed")

    prompt = build_ambient_prompt(preset, req.prompt, slowed_reverb)
    source_duration = slowed_reverb_source_duration(req.duration_seconds, slowed_reverb)

    try:
        result = await run_in_threadpool(
            generate_lofi_ambient_audio,
            backend,
            prompt,
            source_duration,
            req.seed,
            req.segment_seconds,
            req.crossfade_seconds,
            req.guidance_scale,
            req.temperature,
            req.top_k,
        )
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    audio = apply_lofi_effects(result.audio, result.sample_rate, preset.effects)
    if slowed_reverb is not None:
        audio = apply_slowed_reverb_effects(
            audio,
            result.sample_rate,
            playback_rate=slowed_reverb.playback_rate,
            reverb=slowed_reverb.reverb,
            wet_level=slowed_reverb.wet_level,
            lowpass_hz=slowed_reverb.lowpass_hz,
            fade_seconds=slowed_reverb.fade_seconds,
            tail_seconds=slowed_reverb.tail_seconds,
            distance=slowed_reverb.distance,
            gain=slowed_reverb.gain,
            target_duration_seconds=req.duration_seconds,
        )
    return _render_audio_and_respond(audio, result.sample_rate, "musicgen_ambient", req.output)


@app.post("/remake/lofi")
async def remake_lofi(
    file: UploadFile = File(...),
    duration_seconds: float = Query(90.0),
    seed: Optional[int] = Query(None),
    output: str = Query("mp3"),
    use_transformer: bool = Query(False),
    model_id: Optional[str] = Query(None),
):
    with tempfile.TemporaryDirectory() as tmpdir:
        filename = file.filename or "upload.mp3"
        input_path = Path(tmpdir) / filename
        input_path.write_bytes(await file.read())

        ctx = analyze_song(input_path, duration_seconds=duration_seconds, seed=seed)

        notes = extract_melody(input_path)
        if notes:
            ctx.melody_notes = notes

        ctx = build_cover_context(ctx)
        effects_cfg = cover_effects_from_context(ctx)
        backend = _get_backend(use_transformer, model_id)
        midi = backend.generate_midi(ctx)

        formats = [f.strip() for f in output.split(",")]
        return _render_and_respond(midi, effects_cfg, "lofi_remake", formats)


@app.post("/cover/chiptune")
async def cover_chiptune(
    file: UploadFile = File(...),
    duration_seconds: Optional[float] = Query(None),
    seed: Optional[int] = Query(None),
    output: str = Query("mp3"),
    sample_rate: int = Query(44_100),
    bit_depth: int = Query(8),
    chip_rate: int = Query(11_025),
):
    if duration_seconds is not None and duration_seconds <= 0:
        raise HTTPException(400, "duration_seconds must be positive")
    formats = _parse_response_formats(output, allowed={"wav", "mp3"})

    with tempfile.TemporaryDirectory() as tmpdir:
        filename = file.filename or "upload.mp3"
        input_path = Path(tmpdir) / filename
        input_path.write_bytes(await file.read())

        try:
            result = await run_in_threadpool(
                generate_chiptune_cover,
                input_path,
                duration_seconds=duration_seconds,
                seed=seed,
                sample_rate=sample_rate,
                bit_depth=bit_depth,
                chip_rate=chip_rate,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

        return _render_audio_and_respond(result.audio, result.sample_rate, "chiptune_cover", formats)


# ------------------------------------------------------------------ #

def _resolve_api_slowed_reverb_preset(value: Optional[str]):
    if not value:
        return None
    if value.strip().lower() == "random":
        return random_slowed_reverb_preset()
    return get_slowed_reverb_preset(value)


def _parse_response_formats(output: str, allowed: set[str]) -> list[str]:
    formats = list(dict.fromkeys(f.strip().lower() for f in output.split(",") if f.strip()))
    if not formats:
        raise HTTPException(400, "output must include at least one format")

    unsupported = [fmt for fmt in formats if fmt not in allowed]
    if unsupported:
        raise HTTPException(
            400,
            f"unsupported output format(s): {','.join(unsupported)}. Expected: {','.join(sorted(allowed))}",
        )

    return formats

def _render_and_respond(midi, effects_cfg, stem_name: str, formats: list[str]) -> Response:
    with tempfile.TemporaryDirectory() as tmpdir:
        wav_path = Path(tmpdir) / "out.wav"
        midi_to_wav(midi, wav_path)
        audio, sr = sf.read(str(wav_path))
        audio = apply_lofi_effects(audio, sr, effects_cfg)
        results = export_audio(audio, sr, Path(tmpdir) / stem_name, formats=formats)

        for fmt in ("mp3", "wav"):
            if fmt in results:
                content = results[fmt].read_bytes()
                return Response(
                    content=content,
                    media_type=f"audio/{fmt}",
                    headers={"Content-Disposition": f'attachment; filename="{stem_name}.{fmt}"'},
                )

    raise HTTPException(500, "Export produced no output")


def _render_audio_and_respond(audio, sr: int, stem_name: str, formats: list[str]) -> Response:
    with tempfile.TemporaryDirectory() as tmpdir:
        results = export_audio(audio, sr, Path(tmpdir) / stem_name, formats=formats)
        for fmt in ("mp3", "wav"):
            if fmt in results:
                content = results[fmt].read_bytes()
                return Response(
                    content=content,
                    media_type=f"audio/{fmt}",
                    headers={"Content-Disposition": f'attachment; filename="{stem_name}.{fmt}"'},
                )

    raise HTTPException(500, "Export produced no output")
