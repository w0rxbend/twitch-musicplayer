from __future__ import annotations
import logging
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
    import soundfile as sf
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

    click.echo(f"Generating '{preset_name}' — {ctx.bpm:.0f} bpm, {ctx.key}, {duration:.0f}s")
    midi = backend.generate_midi(ctx)

    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    formats = [f.strip() for f in output.split(",")]

    if "midi" in formats:
        midi_out = out_path / f"{preset_name}.mid"
        midi.write(str(midi_out))
        click.echo(f"  MIDI  → {midi_out}")

    if "wav" in formats or "mp3" in formats:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_wav = Path(tmp.name)
        try:
            midi_to_wav(midi, tmp_wav, soundfont=soundfont)
            audio, sr = sf.read(str(tmp_wav))
            audio = apply_lofi_effects(audio, sr, preset.effects)
            for fmt, path in export_audio(audio, sr, out_path / preset_name, formats=formats).items():
                click.echo(f"  {fmt.upper():<5} → {path}")
        finally:
            tmp_wav.unlink(missing_ok=True)


# ------------------------------------------------------------------ #
# songgen remake-lofi
# ------------------------------------------------------------------ #

@cli.command("remake-lofi")
@click.argument("input_file", type=click.Path(exists=True))
@click.option("--preset", default="rainy_window", show_default=True)
@click.option("--preserve-melody", is_flag=True, default=False)
@click.option("--preserve-vocal-chops", is_flag=True, default=False,
              help="Separate stems with Demucs (slow on CPU, needs extras[stems])")
@click.option("--duration", default=90.0, show_default=True)
@click.option("--output", default="mp3", show_default=True)
@click.option("--seed", type=int, default=None)
@click.option("--out-dir", "out_dir", type=click.Path(), default=".", show_default=True)
@click.option("--soundfont", type=click.Path(exists=True), default=None)
@click.option("--transformer", is_flag=True, default=False)
@click.option("--model", default=None)
def remake_lofi(
    input_file: str,
    preset: str,
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
    from .presets.loader import load_preset
    from .analysis.song_analyzer import analyze_song
    from .analysis.melody_extractor import extract_melody
    from .core.lofi_arranger import apply_preset_to_context
    from .render.soundfont import midi_to_wav
    from .render.effects import apply_lofi_effects
    from .render.export import export_audio

    try:
        preset_obj = load_preset(preset)
    except FileNotFoundError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    input_path = Path(input_file)
    click.echo(f"Analysing: {input_path.name}")
    ctx = analyze_song(input_path, duration_seconds=duration, seed=seed)
    click.echo(f"  Key: {ctx.key}  BPM: {ctx.bpm:.1f}  Energy: {ctx.energy:.2f}")

    if preserve_melody:
        click.echo("  Extracting melody (Basic Pitch)…")
        notes = extract_melody(input_path)
        if notes:
            ctx.melody_notes = notes
            click.echo(f"  {len(notes)} melody notes extracted")
        else:
            click.echo("  Basic Pitch unavailable or no notes found")

    if preserve_vocal_chops:
        click.echo("  Separating stems (Demucs CPU — expect 5-20 min)…")
        from .stems.separator import separate_stems
        stems = separate_stems(input_path)
        if stems:
            click.echo(f"  Stems ready: {stems.available_stems}")

    ctx = apply_preset_to_context(ctx, preset_obj)
    backend = _make_backend(transformer, model)

    click.echo(f"Generating lofi remake — {ctx.bpm:.0f} bpm, {ctx.key}")
    midi = backend.generate_midi(ctx)

    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    formats = [f.strip() for f in output.split(",")]

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_wav = Path(tmp.name)

    try:
        midi_to_wav(midi, tmp_wav, soundfont=soundfont)
        audio, sr = sf.read(str(tmp_wav))
        audio = apply_lofi_effects(audio, sr, preset_obj.effects)
        stem_name = input_path.stem + "_lofi"
        for fmt, path in export_audio(audio, sr, out_path / stem_name, formats=formats).items():
            click.echo(f"  {fmt.upper():<5} → {path}")
    finally:
        tmp_wav.unlink(missing_ok=True)


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
