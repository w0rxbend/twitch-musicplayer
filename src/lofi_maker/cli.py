from __future__ import annotations
import logging
import secrets
import sys
import time
import tempfile
from pathlib import Path
from typing import Optional

import click

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")


@click.group()
@click.option("--debug", is_flag=True, default=False)
def cli(debug: bool) -> None:
    if debug:
        logging.basicConfig(level=logging.DEBUG, force=True)


# ------------------------------------------------------------------ #
# songgen presets
# ------------------------------------------------------------------ #

@cli.command()
def presets() -> None:
    """List available lofi presets."""
    from .presets.loader import list_presets, load_preset
    names = list_presets()
    if not names:
        click.echo("No presets found. Check presets/lofi/ directory.")
        return
    click.echo("\nAvailable presets:\n")
    for name in names:
        try:
            p = load_preset(name)
            click.echo(f"  {name:<24} {p.bpm_range[0]}-{p.bpm_range[1]} bpm  {p.mood}")
        except Exception:
            click.echo(f"  {name}")
    click.echo()


# ------------------------------------------------------------------ #
# songgen generate-preset
# ------------------------------------------------------------------ #

@cli.command("generate-preset")
@click.argument("preset_name")
@click.option("--duration", default=90.0, show_default=True, help="Duration in seconds")
@click.option("--output", default="mp3", show_default=True, help="Comma-separated: midi,wav,mp3")
@click.option("--seed", type=int, default=None)
@click.option("--out-dir", "out_dir", type=click.Path(), default=".", show_default=True)
@click.option("--soundfont", type=click.Path(exists=True), default=None)
@click.option("--transformer", is_flag=True, default=False, help="Use open-weight transformer backend")
@click.option("--model", default=None, help="HuggingFace model ID (default: sander-wood/text-to-music)")
def generate_preset(
    preset_name: str,
    duration: float,
    output: str,
    seed: Optional[int],
    out_dir: str,
    soundfont: Optional[str],
    transformer: bool,
    model: Optional[str],
) -> None:
    """Generate an original lofi beat from a preset."""
    _generate_preset_audio(
        preset_name=preset_name,
        duration=duration,
        output=output,
        seed=seed,
        out_dir=out_dir,
        soundfont=soundfont,
        transformer=transformer,
        model=model,
        output_name=preset_name,
    )


# ------------------------------------------------------------------ #
# songgen generate-random
# ------------------------------------------------------------------ #

@cli.command("generate-random")
@click.argument("preset_name")
@click.option("--count", default=1, show_default=True, help="Number of random versions to generate")
@click.option("--duration", default=90.0, show_default=True, help="Duration in seconds")
@click.option("--output", default="mp3", show_default=True, help="Comma-separated: midi,wav,mp3")
@click.option("--out-dir", "out_dir", type=click.Path(), default=".", show_default=True)
@click.option("--soundfont", type=click.Path(exists=True), default=None)
@click.option("--transformer", is_flag=True, default=False, help="Use open-weight transformer backend")
@click.option("--model", default=None, help="HuggingFace model ID (default: sander-wood/text-to-music)")
def generate_random(
    preset_name: str,
    count: int,
    duration: float,
    output: str,
    out_dir: str,
    soundfont: Optional[str],
    transformer: bool,
    model: Optional[str],
) -> None:
    """Generate one or more random versions from a preset."""
    if count < 1:
        click.echo("Error: count must be at least 1", err=True)
        sys.exit(1)

    for index in range(1, count + 1):
        seed = secrets.randbelow(2_147_483_647)
        output_name = f"{preset_name}_random_{seed}"
        if count > 1:
            click.echo(f"\nRandom version {index}/{count} (seed={seed})")
        else:
            click.echo(f"Random version seed={seed}")

        _generate_preset_audio(
            preset_name=preset_name,
            duration=duration,
            output=output,
            seed=seed,
            out_dir=out_dir,
            soundfont=soundfont,
            transformer=transformer,
            model=model,
            output_name=output_name,
        )


# ------------------------------------------------------------------ #
# songgen generate-ambient
# ------------------------------------------------------------------ #

@cli.command("generate-ambient")
@click.option("--prompt", default=None, help="Text prompt for MusicGen")
@click.option("--preset", default="ambient_lofi", show_default=True,
              help="Preset used for prompt color and lofi effects")
@click.option("--duration", default=12.0, show_default=True,
              help="Final duration in seconds. MusicGen is chunked above 30s.")
@click.option("--segment-duration", default=12.0, show_default=True,
              help="MusicGen chunk length in seconds, capped at 30")
@click.option("--crossfade", default=1.0, show_default=True,
              help="Crossfade between generated chunks")
@click.option("--output", default="mp3", show_default=True, help="Comma-separated: wav,mp3")
@click.option("--seed", type=int, default=None)
@click.option("--out-dir", "out_dir", type=click.Path(), default=".", show_default=True)
@click.option("--model", default="facebook/musicgen-small", show_default=True)
@click.option("--runtime", type=click.Choice(["transformers", "openvino"]), default="transformers",
              show_default=True)
@click.option("--device", default="cpu", show_default=True,
              help="Torch device for transformers runtime")
@click.option("--openvino-device", default="CPU", show_default=True,
              help="OpenVINO device for openvino runtime")
@click.option("--openvino-model-dir", type=click.Path(), default=None,
              help="Directory for converted OpenVINO IR files")
@click.option("--guidance-scale", default=3.0, show_default=True)
@click.option("--temperature", default=1.0, show_default=True)
@click.option("--top-k", default=250, show_default=True)
def generate_ambient(
    prompt: Optional[str],
    preset: str,
    duration: float,
    segment_duration: float,
    crossfade: float,
    output: str,
    seed: Optional[int],
    out_dir: str,
    model: str,
    runtime: str,
    device: str,
    openvino_device: str,
    openvino_model_dir: Optional[str],
    guidance_scale: float,
    temperature: float,
    top_k: int,
) -> None:
    """Generate lofi ambient audio with facebook/musicgen-small."""
    from .ai.musicgen import MusicGenSmallBackend
    from .core.neural_ambient import build_ambient_prompt, generate_lofi_ambient_audio
    from .presets.loader import load_preset
    from .render.effects import apply_lofi_effects
    from .render.export import export_audio

    try:
        preset_cfg = load_preset(preset)
    except FileNotFoundError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    backend = MusicGenSmallBackend(
        model_id=model,
        runtime=runtime,
        device=device,
        openvino_model_dir=openvino_model_dir,
        openvino_device=openvino_device,
        segment_seconds=segment_duration,
    )
    if not backend.available:
        click.echo("Error: MusicGen dependencies are not installed.", err=True)
        click.echo(f"Install MusicGen support: {_optional_dependency_install_hint('musicgen')}", err=True)
        if runtime == "openvino":
            click.echo(f"Install OpenVINO support: {_optional_dependency_install_hint('musicgen-openvino')}", err=True)
        sys.exit(1)

    final_prompt = build_ambient_prompt(preset_cfg, prompt)
    formats = [f.strip() for f in output.split(",") if f.strip()]
    if not formats:
        click.echo("Error: --output must include at least one format", err=True)
        sys.exit(1)

    click.echo(f"Generating lofi ambient audio with {model} ({runtime})")
    click.echo(f"  Duration: {duration:.1f}s  Segment: {min(segment_duration, 30.0):.1f}s")
    click.echo(f"  Prompt: {final_prompt}")

    try:
        result = generate_lofi_ambient_audio(
            backend=backend,
            prompt=final_prompt,
            duration_seconds=duration,
            seed=seed,
            segment_seconds=segment_duration,
            crossfade_seconds=crossfade,
            guidance_scale=guidance_scale,
            temperature=temperature,
            top_k=top_k,
        )
    except RuntimeError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    audio = apply_lofi_effects(result.audio, result.sample_rate, preset_cfg.effects)
    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    suffix = f"seed_{seed}" if seed is not None else str(int(time.time()))
    output_name = f"{preset}_musicgen_{suffix}"
    for fmt, path in export_audio(audio, result.sample_rate, out_path / output_name, formats=formats).items():
        click.echo(f"  {fmt.upper():<5} → {path}")
    click.echo(f"  Segments: {result.segment_count}")


def _generate_preset_audio(
    preset_name: str,
    duration: float,
    output: str,
    seed: Optional[int],
    out_dir: str,
    soundfont: Optional[str],
    transformer: bool,
    model: Optional[str],
    output_name: str,
) -> None:
    from .presets.loader import load_preset
    from .core.lofi_arranger import from_preset
    from .render.soundfont import midi_to_wav
    from .render.effects import apply_lofi_effects
    from .render.export import export_audio

    try:
        preset = load_preset(preset_name)
    except FileNotFoundError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    ctx = from_preset(preset, duration_seconds=duration, seed=seed)
    backend = _make_backend(transformer, model)

    click.echo(
        f"Generating '{preset_name}' — {ctx.bpm:.0f} bpm, {ctx.key}, "
        f"{duration:.0f}s"
    )
    midi = backend.generate_midi(ctx)

    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    formats = [f.strip() for f in output.split(",")]

    if "midi" in formats:
        midi_out = out_path / f"{output_name}.mid"
        midi.write(str(midi_out))
        click.echo(f"  MIDI  → {midi_out}")

    if "wav" in formats or "mp3" in formats:
        import soundfile as sf

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_wav = Path(tmp.name)
        try:
            midi_to_wav(midi, tmp_wav, soundfont=soundfont)
            audio, sr = sf.read(str(tmp_wav))
            audio = apply_lofi_effects(audio, sr, preset.effects)
            for fmt, path in export_audio(audio, sr, out_path / output_name, formats=formats).items():
                click.echo(f"  {fmt.upper():<5} → {path}")
        finally:
            tmp_wav.unlink(missing_ok=True)


# ------------------------------------------------------------------ #
# songgen remake-lofi
# ------------------------------------------------------------------ #

@cli.command("remake-lofi")
@click.argument("input_file", type=click.Path(exists=True))
@click.option("--skip-stems", is_flag=True, default=False,
              help="Skip Demucs stem separation before analysis")
@click.option("--preset", default=None, hidden=True)
@click.option("--preserve-melody", is_flag=True, default=False, hidden=True)
@click.option("--preserve-vocal-chops", is_flag=True, default=False, hidden=True)
@click.option("--duration", default=90.0, show_default=True)
@click.option("--output", default="mp3", show_default=True)
@click.option("--seed", type=int, default=None)
@click.option("--out-dir", "out_dir", type=click.Path(), default=".", show_default=True)
@click.option("--soundfont", type=click.Path(exists=True), default=None)
@click.option("--transformer", is_flag=True, default=False)
@click.option("--model", default=None)
def remake_lofi(
    input_file: str,
    skip_stems: bool,
    preset: Optional[str],
    preserve_melody: bool,
    preserve_vocal_chops: bool,
    duration: float,
    output: str,
    seed: Optional[int],
    out_dir: str,
    soundfont: Optional[str],
    transformer: bool,
    model: Optional[str],
) -> None:
    """Create a lofi reinterpretation of any song."""
    import soundfile as sf
    from .analysis.song_analyzer import analyze_song
    from .analysis.melody_extractor import extract_melody
    from .core.lofi_arranger import build_cover_context, cover_effects_from_context
    from .render.soundfont import midi_to_wav
    from .render.effects import apply_lofi_effects
    from .render.export import export_audio

    input_path = Path(input_file)
    if preset:
        click.echo("Ignoring --preset: remake-lofi is source-driven now.")
    if preserve_melody or preserve_vocal_chops:
        click.echo("Melody extraction and stem separation are part of the remake pipeline now.")

    click.echo(f"Cover-generation pipeline: {input_path.name}")
    stems = None
    stem_tmp_paths: list[Path] = []
    analysis_path = input_path
    melody_path = input_path
    if not skip_stems:
        click.echo("  Demucs stem separation...")
        from .stems.separator import separate_stems
        stems = separate_stems(input_path)
        if stems:
            click.echo(f"  Stems ready: {', '.join(stems.available_stems)}")
            analysis_audio = _mix_stem_audio(stems.other, stems.bass)
            if analysis_audio is not None:
                analysis_path = _write_temp_audio(analysis_audio, stems.sr, "_analysis.wav")
                stem_tmp_paths.append(analysis_path)

            melody_audio = stems.vocals if stems.vocals is not None else stems.other
            if melody_audio is not None:
                melody_path = _write_temp_audio(melody_audio, stems.sr, "_melody.wav")
                stem_tmp_paths.append(melody_path)
        else:
            click.echo("  Demucs unavailable or failed; continuing with full-mix analysis")
            click.echo(f"  Install stems: {_optional_dependency_install_hint('stems')}")

    try:
        click.echo("  Tempo/key/chord/melody analysis...")
        ctx = analyze_song(analysis_path, duration_seconds=duration, seed=seed)
        click.echo(
            f"  Key: {ctx.key}  Source BPM: {ctx.source_bpm or ctx.bpm:.1f}  "
            f"Cover BPM: {ctx.bpm:.1f}  Energy: {ctx.energy:.2f}"
        )

        click.echo("  Melody transcription...")
        notes = extract_melody(melody_path)
        if notes:
            ctx.melody_notes = notes
            click.echo(f"  {len(notes)} source melody notes extracted")
        else:
            click.echo("  Basic Pitch unavailable or no melody found; generating a sparse guide melody")
            click.echo(f"  Install melody transcription: {_optional_dependency_install_hint('melody')}")

        click.echo("  Arrangement transformation + new instrumentation...")
        ctx = build_cover_context(ctx)
        effects_cfg = cover_effects_from_context(ctx)
        backend = _make_backend(transformer, model)

        click.echo(f"  MIDI + generated layers: {ctx.bpm:.0f} bpm, {ctx.key}")
        midi = backend.generate_midi(ctx)

        out_path = Path(out_dir)
        out_path.mkdir(parents=True, exist_ok=True)
        formats = [f.strip() for f in output.split(",")]
        stem_name = input_path.stem + "_lofi"

        if "midi" in formats:
            midi_out = out_path / f"{stem_name}.mid"
            midi.write(str(midi_out))
            click.echo(f"  MIDI  → {midi_out}")

        if "wav" in formats or "mp3" in formats:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp_wav = Path(tmp.name)

            try:
                midi_to_wav(midi, tmp_wav, soundfont=soundfont)
                audio, sr = sf.read(str(tmp_wav))
                click.echo("  Rendering + mixing/mastering...")
                audio = apply_lofi_effects(audio, sr, effects_cfg)
                for fmt, path in export_audio(audio, sr, out_path / stem_name, formats=formats).items():
                    click.echo(f"  {fmt.upper():<5} → {path}")
            finally:
                tmp_wav.unlink(missing_ok=True)
    finally:
        for path in stem_tmp_paths:
            path.unlink(missing_ok=True)


def _mix_stem_audio(*stems):
    import numpy as np

    available = [stem for stem in stems if stem is not None]
    if not available:
        return None

    length = min(len(stem) for stem in available)
    if length <= 0:
        return None

    mixed = np.zeros(length, dtype=np.float32)
    for stem in available:
        mixed += stem[:length].astype(np.float32)

    peak = float(np.max(np.abs(mixed))) if mixed.size else 0.0
    if peak > 1.0:
        mixed /= peak
    return mixed


def _write_temp_audio(audio, sr: int, suffix: str) -> Path:
    import soundfile as sf

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        path = Path(tmp.name)
    sf.write(str(path), audio, sr)
    return path


def _optional_dependency_install_hint(extra: str) -> str:
    if extra == "melody" and sys.version_info >= (3, 12):
        return "Basic Pitch requires Python 3.10/3.11; Python 3.12+ uses the built-in librosa fallback"
    if extra == "musicgen-openvino":
        if Path("uv.lock").exists():
            return "pipx run uv sync --extra musicgen-openvino"
        return f"{sys.executable} -m pip install -e '.[musicgen-openvino]'"
    if Path("uv.lock").exists():
        return f"pipx run uv sync --extra {extra}"
    return f"{sys.executable} -m pip install -e '.[{extra}]'"


# ------------------------------------------------------------------ #
# songgen serve
# ------------------------------------------------------------------ #

@cli.command()
@click.option("--host", default="0.0.0.0", show_default=True)
@click.option("--port", default=8000, show_default=True)
def serve(host: str, port: int) -> None:
    """Start the FastAPI server."""
    import uvicorn
    from .api import app
    uvicorn.run(app, host=host, port=port)


# ------------------------------------------------------------------ #
# songgen download-ncs-music
# ------------------------------------------------------------------ #

@cli.command("download-ncs-music")
@click.argument("source", required=False, default="")
@click.option("--genre", default="", help="NCS genre id, e.g. 12")
@click.option("--mood", default="", help="NCS mood id, e.g. 20")
@click.option("--version", default=None, type=click.Choice(["regular", "instrumental"]))
@click.option("--limit", default=20, show_default=True, help="Maximum tracks to download")
@click.option("--pages", default=3, show_default=True, help="Search pages to inspect")
@click.option("--delay", default=1.5, show_default=True, help="Delay between requests in seconds")
@click.option("--out-dir", "out_dir", type=click.Path(), default="ncs_music", show_default=True)
@click.option("--dry-run", is_flag=True, default=False, help="List tracks without downloading")
def download_ncs_music(
    source: str,
    genre: str,
    mood: str,
    version: Optional[str],
    limit: int,
    pages: int,
    delay: float,
    out_dir: str,
    dry_run: bool,
) -> None:
    """Download a bounded set of NCS music search results."""
    from .sources.ncs_music import (
        NcsDownloadError,
        append_manifest,
        download_file,
        fetch_search_results,
        read_manifest_ids,
        safe_output_name,
        trim_limit,
    )

    try:
        limit = trim_limit(limit)
    except ValueError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    if pages < 1:
        click.echo("Error: pages must be at least 1", err=True)
        sys.exit(1)
    if delay < 0:
        click.echo("Error: delay cannot be negative", err=True)
        sys.exit(1)

    output_path = Path(out_dir)
    manifest_path = output_path / "ncs_music_manifest.jsonl"
    seen_manifest_ids = read_manifest_ids(manifest_path)

    label = source or "NCS music search"
    click.echo(f"Searching NCS for '{label}' (limit={limit}, pages={pages}, delay={delay:g}s)")

    try:
        tracks = fetch_search_results(
            source,
            pages=pages,
            delay=delay,
            genre=genre,
            mood=mood,
            version=version or "",
        )
    except NcsDownloadError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    if not tracks:
        click.echo("No NCS music results found.")
        return

    downloaded = 0
    inspected = 0
    for track in tracks:
        if inspected >= limit:
            break
        inspected += 1

        file_path = output_path / safe_output_name(track)
        click.echo(f"  {inspected:>3}. {track.title} — {track.artist}")

        if dry_run:
            click.echo(f"       {track.page_url}")
            continue

        if file_path.exists() and file_path.stat().st_size > 0:
            click.echo(f"       exists: {file_path}")
        else:
            try:
                bytes_written = download_file(track.download_url, file_path)
            except NcsDownloadError as exc:
                click.echo(f"       failed: {exc}", err=True)
                continue
            downloaded += 1
            click.echo(f"       saved: {file_path} ({bytes_written / 1024 / 1024:.1f} MB)")

        if track.id not in seen_manifest_ids:
            append_manifest(manifest_path, track, file_path)
            seen_manifest_ids.add(track.id)

        time.sleep(delay)

    if dry_run:
        click.echo(f"Found {inspected} track(s).")
    else:
        click.echo(f"Downloaded {downloaded} new track(s). Manifest: {manifest_path}")


# ------------------------------------------------------------------ #

def _make_backend(use_transformer: bool, model_id: Optional[str]):
    if use_transformer:
        from .ai.transformer import TransformerMidiBackend
        return TransformerMidiBackend(model_id=model_id or "sander-wood/text-to-music")
    from .ai.rule_based import RuleBasedBackend
    return RuleBasedBackend()
