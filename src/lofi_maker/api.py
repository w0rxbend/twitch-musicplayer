from __future__ import annotations
import tempfile
from pathlib import Path
from typing import Optional

import soundfile as sf
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from .analysis.melody_extractor import extract_melody
from .analysis.song_analyzer import analyze_song
from .core.lofi_arranger import apply_preset_to_context, from_preset
from .presets.loader import list_presets, load_preset
from .render.effects import apply_lofi_effects
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


@app.post("/remake/lofi")
async def remake_lofi(
    file: UploadFile = File(...),
    preset: str = Query("rainy_window"),
    preserve_melody: bool = Query(False),
    duration_seconds: float = Query(90.0),
    seed: Optional[int] = Query(None),
    output: str = Query("mp3"),
    use_transformer: bool = Query(False),
    model_id: Optional[str] = Query(None),
):
    try:
        preset_obj = load_preset(preset)
    except FileNotFoundError:
        raise HTTPException(404, f"Preset '{preset}' not found")

    with tempfile.TemporaryDirectory() as tmpdir:
        filename = file.filename or "upload.mp3"
        input_path = Path(tmpdir) / filename
        input_path.write_bytes(await file.read())

        ctx = analyze_song(input_path, duration_seconds=duration_seconds, seed=seed)

        if preserve_melody:
            notes = extract_melody(input_path)
            if notes:
                ctx.melody_notes = notes

        ctx = apply_preset_to_context(ctx, preset_obj)
        backend = _get_backend(use_transformer, model_id)
        midi = backend.generate_midi(ctx)

        formats = [f.strip() for f in output.split(",")]
        return _render_and_respond(midi, preset_obj.effects, "lofi_remake", formats)


# ------------------------------------------------------------------ #

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
