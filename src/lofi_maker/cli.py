from __future__ import annotations
import gc
import json
import logging
import secrets
import sys
import time
import tempfile
from datetime import datetime, timezone
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


@cli.command("slowed-reverb-presets")
def slowed_reverb_presets() -> None:
    """List available slowed + reverb ambient effect presets."""
    from .core.neural_ambient import list_slowed_reverb_presets

    click.echo("\nAvailable slowed + reverb presets:\n")
    for preset in list_slowed_reverb_presets():
        click.echo(
            f"  {preset.name:<24} {preset.playback_rate:.2f}x  "
            f"reverb={preset.reverb:.2f}  {preset.title}"
        )
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
@click.option("--slowed-reverb-preset", default=None,
              help="Apply a named slowed + reverb preset, or 'random'")
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
    slowed_reverb_preset: Optional[str],
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
    from .core.neural_ambient import (
        build_ambient_prompt,
        generate_lofi_ambient_audio,
        slowed_reverb_source_duration,
    )
    from .presets.loader import load_preset
    from .render.effects import apply_lofi_effects, apply_slowed_reverb_effects
    from .render.export import export_audio

    try:
        preset_cfg = load_preset(preset)
    except FileNotFoundError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    try:
        slow_reverb_cfg = _resolve_slowed_reverb_preset(slowed_reverb_preset)
    except ValueError as exc:
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

    final_prompt = build_ambient_prompt(preset_cfg, prompt, slow_reverb_cfg)
    source_duration = slowed_reverb_source_duration(duration, slow_reverb_cfg)
    try:
        formats = _parse_audio_formats(output, allowed={"wav", "mp3"})
    except ValueError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    click.echo(f"Generating lofi ambient audio with {model} ({runtime})")
    click.echo(f"  Duration: {duration:.1f}s  Segment: {min(segment_duration, 30.0):.1f}s")
    if slow_reverb_cfg is not None:
        click.echo(
            f"  Slowed + reverb: {slow_reverb_cfg.title}  "
            f"source={source_duration:.1f}s playback={slow_reverb_cfg.playback_rate:.2f}x"
        )
    click.echo(f"  Prompt: {final_prompt}")

    try:
        result = generate_lofi_ambient_audio(
            backend=backend,
            prompt=final_prompt,
            duration_seconds=source_duration,
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
    if slow_reverb_cfg is not None:
        audio = apply_slowed_reverb_effects(
            audio,
            result.sample_rate,
            playback_rate=slow_reverb_cfg.playback_rate,
            reverb=slow_reverb_cfg.reverb,
            wet_level=slow_reverb_cfg.wet_level,
            lowpass_hz=slow_reverb_cfg.lowpass_hz,
            fade_seconds=slow_reverb_cfg.fade_seconds,
            tail_seconds=slow_reverb_cfg.tail_seconds,
            distance=slow_reverb_cfg.distance,
            gain=slow_reverb_cfg.gain,
            target_duration_seconds=duration,
        )
    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    suffix = f"seed_{seed}" if seed is not None else str(int(time.time()))
    effect_suffix = f"_{slow_reverb_cfg.name}" if slow_reverb_cfg is not None else ""
    output_name = f"{preset}{effect_suffix}_musicgen_{suffix}"
    for fmt, path in export_audio(audio, result.sample_rate, out_path / output_name, formats=formats).items():
        click.echo(f"  {fmt.upper():<5} → {path}")
    click.echo(f"  Segments: {result.segment_count}")


# ------------------------------------------------------------------ #
# songgen generate-ambient-batch
# ------------------------------------------------------------------ #

@cli.command("generate-ambient-batch")
@click.option("--prompt", default=None, help="Text prompt for MusicGen")
@click.option("--preset", default="ambient_lofi", show_default=True,
              help="Preset used for prompt color and lofi effects")
@click.option("--random-presets", is_flag=True, default=False,
              help="Randomly choose from all available lofi presets for each track")
@click.option("--slowed-reverb-preset", default=None,
              help="Apply a named slowed + reverb preset for every track, or 'random'")
@click.option("--random-slowed-reverb-presets", is_flag=True, default=False,
              help="Randomly choose from slowed + reverb effect presets for each track")
@click.option("--run-hours", default=24.0, show_default=True,
              help="How long the supervised run should keep generating")
@click.option("--max-tracks", type=int, default=None,
              help="Optional hard cap on successful tracks")
@click.option("--duration", default=180.0, show_default=True,
              help="Duration of each generated track in seconds")
@click.option("--segment-duration", default=30.0, show_default=True,
              help="MusicGen chunk length in seconds, capped at 30")
@click.option("--crossfade", default=2.0, show_default=True,
              help="Crossfade between generated chunks")
@click.option("--output", default="mp3", show_default=True, help="Comma-separated: wav,mp3")
@click.option("--out-dir", "out_dir", type=click.Path(), default=None,
              help="Output directory. Defaults to output/ambient_batch_TIMESTAMP")
@click.option("--manifest", type=click.Path(), default=None,
              help="JSONL manifest path. Defaults to OUT_DIR/ambient_batch_manifest.jsonl")
@click.option("--model", default="facebook/musicgen-small", show_default=True)
@click.option("--runtime", type=click.Choice(["transformers", "openvino"]), default="openvino",
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
@click.option("--sleep-on-error", default=30.0, show_default=True,
              help="Seconds to wait after a failed track before continuing")
@click.option("--stop-on-error", is_flag=True, default=False,
              help="Stop the run after the first failed track")
@click.option("--dry-run", is_flag=True, default=False,
              help="Print the run plan without loading the model")
def generate_ambient_batch(
    prompt: Optional[str],
    preset: str,
    random_presets: bool,
    slowed_reverb_preset: Optional[str],
    random_slowed_reverb_presets: bool,
    run_hours: float,
    max_tracks: Optional[int],
    duration: float,
    segment_duration: float,
    crossfade: float,
    output: str,
    out_dir: Optional[str],
    manifest: Optional[str],
    model: str,
    runtime: str,
    device: str,
    openvino_device: str,
    openvino_model_dir: Optional[str],
    guidance_scale: float,
    temperature: float,
    top_k: int,
    sleep_on_error: float,
    stop_on_error: bool,
    dry_run: bool,
) -> None:
    """Generate lofi ambient tracks continuously for a supervised run."""
    from .ai.musicgen import MusicGenSmallBackend
    from .core.neural_ambient import (
        build_ambient_prompt,
        generate_lofi_ambient_audio,
        slowed_reverb_source_duration,
    )
    from .presets.loader import list_presets, load_preset
    from .render.effects import apply_lofi_effects, apply_slowed_reverb_effects
    from .render.export import export_audio

    if run_hours <= 0:
        click.echo("Error: --run-hours must be greater than 0", err=True)
        sys.exit(1)
    if max_tracks is not None and max_tracks < 1:
        click.echo("Error: --max-tracks must be at least 1", err=True)
        sys.exit(1)
    if duration <= 0:
        click.echo("Error: --duration must be greater than 0", err=True)
        sys.exit(1)
    if segment_duration <= 0:
        click.echo("Error: --segment-duration must be greater than 0", err=True)
        sys.exit(1)
    if crossfade < 0:
        click.echo("Error: --crossfade cannot be negative", err=True)
        sys.exit(1)
    if sleep_on_error < 0:
        click.echo("Error: --sleep-on-error cannot be negative", err=True)
        sys.exit(1)

    try:
        if random_presets:
            preset_names = list_presets()
            if not preset_names:
                click.echo("Error: no lofi presets found", err=True)
                sys.exit(1)
            preset_choices = [(name, load_preset(name)) for name in preset_names]
        else:
            preset_choices = [(preset, load_preset(preset))]
    except FileNotFoundError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    try:
        slowed_reverb_choices = _resolve_slowed_reverb_preset_choices(
            slowed_reverb_preset,
            random_slowed_reverb_presets,
        )
    except ValueError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    try:
        formats = _parse_audio_formats(output, allowed={"wav", "mp3"})
    except ValueError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    started_at = datetime.now()
    out_path = Path(out_dir) if out_dir else Path("output") / f"ambient_batch_{started_at:%Y%m%d_%H%M%S}"
    manifest_path = Path(manifest) if manifest else out_path / "ambient_batch_manifest.jsonl"
    first_slowed_reverb = slowed_reverb_choices[0] if slowed_reverb_choices else None
    first_prompt = build_ambient_prompt(preset_choices[0][1], prompt, first_slowed_reverb)
    deadline = time.monotonic() + run_hours * 3600.0

    click.echo("Ambient batch generation plan")
    click.echo(f"  Runtime: {runtime}  Model: {model}")
    if runtime == "openvino":
        click.echo(f"  OpenVINO device: {openvino_device}")
    else:
        click.echo(f"  Torch device: {device}")
    click.echo(f"  Run length: {run_hours:g}h")
    click.echo(f"  Track duration: {duration:.1f}s  Segment: {min(segment_duration, 30.0):.1f}s")
    if random_presets:
        click.echo(f"  Presets: random from {len(preset_choices)} available lofi presets")
    else:
        click.echo(f"  Preset: {preset_choices[0][0]}")
    if len(slowed_reverb_choices) > 1:
        click.echo(f"  Slowed + reverb: random from {len(slowed_reverb_choices)} effect presets")
    elif first_slowed_reverb is not None:
        click.echo(
            f"  Slowed + reverb: {first_slowed_reverb.title}  "
            f"playback={first_slowed_reverb.playback_rate:.2f}x"
        )
    else:
        click.echo("  Slowed + reverb: off")
    click.echo(f"  Output: {','.join(formats)}")
    click.echo(f"  Out dir: {out_path}")
    click.echo(f"  Manifest: {manifest_path}")
    click.echo(f"  Prompt template: {prompt.strip() if prompt and prompt.strip() else 'default ambient prompt'}")
    click.echo(f"  First prompt example: {first_prompt}")

    if dry_run:
        return

    out_path.mkdir(parents=True, exist_ok=True)
    _append_jsonl(
        manifest_path,
        {
            "event": "run_started",
            "started_at": _utc_now_iso(),
            "run_hours": run_hours,
            "max_tracks": max_tracks,
            "track_duration_seconds": duration,
            "segment_duration_seconds": min(segment_duration, 30.0),
            "crossfade_seconds": crossfade,
            "formats": formats,
            "model_id": model,
            "runtime": runtime,
            "device": device,
            "openvino_device": openvino_device,
            "openvino_model_dir": openvino_model_dir,
            "base_prompt": prompt,
            "random_presets": random_presets,
            "preset": None if random_presets else preset_choices[0][0],
            "preset_count": len(preset_choices),
            "presets": [name for name, _ in preset_choices],
            "random_slowed_reverb_presets": len(slowed_reverb_choices) > 1,
            "slowed_reverb_preset": None if len(slowed_reverb_choices) != 1 or first_slowed_reverb is None else first_slowed_reverb.name,
            "slowed_reverb_presets": [preset.name for preset in slowed_reverb_choices],
        },
    )

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

    ok_count = 0
    failed_count = 0
    attempt = 0

    try:
        while time.monotonic() < deadline:
            if max_tracks is not None and ok_count >= max_tracks:
                break

            attempt += 1
            seed = secrets.randbelow(2_147_483_647)
            track_preset, track_preset_cfg = secrets.choice(preset_choices)
            track_slowed_reverb = secrets.choice(slowed_reverb_choices) if slowed_reverb_choices else None
            track_prompt = build_ambient_prompt(track_preset_cfg, prompt, track_slowed_reverb)
            source_duration = slowed_reverb_source_duration(duration, track_slowed_reverb)
            effect_suffix = f"_{track_slowed_reverb.name}" if track_slowed_reverb is not None else ""
            output_name = f"{track_preset}{effect_suffix}_musicgen_{attempt:04d}_seed_{seed}"
            track_started = time.monotonic()
            click.echo()
            effect_label = track_slowed_reverb.name if track_slowed_reverb is not None else "none"
            click.echo(
                f"[{_local_now_label()}] Track attempt {attempt} "
                f"preset={track_preset} slowed_reverb={effect_label} (seed={seed})"
            )

            try:
                result = generate_lofi_ambient_audio(
                    backend=backend,
                    prompt=track_prompt,
                    duration_seconds=source_duration,
                    seed=seed,
                    segment_seconds=segment_duration,
                    crossfade_seconds=crossfade,
                    guidance_scale=guidance_scale,
                    temperature=temperature,
                    top_k=top_k,
                )
                audio = apply_lofi_effects(result.audio, result.sample_rate, track_preset_cfg.effects)
                if track_slowed_reverb is not None:
                    audio = apply_slowed_reverb_effects(
                        audio,
                        result.sample_rate,
                        playback_rate=track_slowed_reverb.playback_rate,
                        reverb=track_slowed_reverb.reverb,
                        wet_level=track_slowed_reverb.wet_level,
                        lowpass_hz=track_slowed_reverb.lowpass_hz,
                        fade_seconds=track_slowed_reverb.fade_seconds,
                        tail_seconds=track_slowed_reverb.tail_seconds,
                        distance=track_slowed_reverb.distance,
                        gain=track_slowed_reverb.gain,
                        target_duration_seconds=duration,
                    )
                exported = export_audio(audio, result.sample_rate, out_path / output_name, formats=formats)
                elapsed = time.monotonic() - track_started
                ok_count += 1

                for fmt, path in exported.items():
                    click.echo(f"  {fmt.upper():<5} → {path}")
                click.echo(
                    f"  Done in {elapsed / 60.0:.1f} min  "
                    f"Source: {source_duration:.1f}s  Segments: {result.segment_count}"
                )

                _append_jsonl(
                    manifest_path,
                    {
                        "event": "track_completed",
                        "completed_at": _utc_now_iso(),
                        "attempt": attempt,
                        "track_index": ok_count,
                        "preset": track_preset,
                        "slowed_reverb_preset": None if track_slowed_reverb is None else track_slowed_reverb.name,
                        "slowed_reverb_title": None if track_slowed_reverb is None else track_slowed_reverb.title,
                        "prompt": track_prompt,
                        "seed": seed,
                        "elapsed_seconds": elapsed,
                        "duration_seconds": duration,
                        "source_duration_seconds": source_duration,
                        "segment_count": result.segment_count,
                        "sample_rate": result.sample_rate,
                        "outputs": {fmt: str(path) for fmt, path in exported.items()},
                        "output_name": output_name,
                    },
                )
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                elapsed = time.monotonic() - track_started
                failed_count += 1
                click.echo(f"  Failed after {elapsed / 60.0:.1f} min: {exc}", err=True)
                _append_jsonl(
                    manifest_path,
                    {
                        "event": "track_failed",
                        "failed_at": _utc_now_iso(),
                        "attempt": attempt,
                        "preset": track_preset,
                        "slowed_reverb_preset": None if track_slowed_reverb is None else track_slowed_reverb.name,
                        "prompt": track_prompt,
                        "seed": seed,
                        "elapsed_seconds": elapsed,
                        "error": repr(exc),
                    },
                )
                if stop_on_error:
                    raise click.ClickException(str(exc)) from exc
                if time.monotonic() < deadline and sleep_on_error > 0:
                    time.sleep(min(sleep_on_error, max(0.0, deadline - time.monotonic())))
            finally:
                gc.collect()
    except KeyboardInterrupt:
        click.echo("\nInterrupted; writing run summary.")
        _append_jsonl(
            manifest_path,
            {
                "event": "run_interrupted",
                "interrupted_at": _utc_now_iso(),
                "attempts": attempt,
                "completed_tracks": ok_count,
                "failed_tracks": failed_count,
            },
        )
        sys.exit(130)

    _append_jsonl(
        manifest_path,
        {
            "event": "run_finished",
            "finished_at": _utc_now_iso(),
            "attempts": attempt,
            "completed_tracks": ok_count,
            "failed_tracks": failed_count,
            "manifest": str(manifest_path),
        },
    )
    click.echo()
    click.echo(f"Batch finished. Completed: {ok_count}. Failed: {failed_count}. Manifest: {manifest_path}")


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


# ------------------------------------------------------------------ #
# songgen cover-chiptune
# ------------------------------------------------------------------ #

@cli.command("cover-chiptune")
@click.argument("input_file", type=click.Path(exists=True))
@click.option("--use-stems", is_flag=True, default=False,
              help="Use Demucs stems for cleaner melody/harmony analysis")
@click.option("--duration", type=float, default=None,
              help="Optional maximum output duration in seconds. Defaults to source length.")
@click.option("--output", default="mp3", show_default=True,
              help="Comma-separated: wav,mp3")
@click.option("--seed", type=int, default=None)
@click.option("--out-dir", "out_dir", type=click.Path(), default=".", show_default=True)
@click.option("--sample-rate", default=44_100, show_default=True)
@click.option("--bit-depth", default=8, show_default=True,
              help="Quantization depth for the final chip-style master")
@click.option("--chip-rate", default=11_025, show_default=True,
              help="Sample-hold rate for the final chip-style master")
def cover_chiptune(
    input_file: str,
    use_stems: bool,
    duration: Optional[float],
    output: str,
    seed: Optional[int],
    out_dir: str,
    sample_rate: int,
    bit_depth: int,
    chip_rate: int,
) -> None:
    """Create an 8-bit chiptune cover from an existing song."""
    from .core.chiptune import generate_chiptune_cover
    from .render.export import export_audio

    input_path = Path(input_file)
    if duration is not None and duration <= 0:
        click.echo("Error: --duration must be greater than 0", err=True)
        sys.exit(1)

    try:
        formats = _parse_audio_formats(output, allowed={"wav", "mp3"})
    except ValueError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    click.echo(f"Chiptune cover pipeline: {input_path.name}")
    analysis_path = input_path
    melody_path = input_path
    stem_tmp_paths: list[Path] = []

    if use_stems:
        click.echo("  Demucs stem separation...")
        from .stems.separator import separate_stems

        stems = separate_stems(input_path)
        if stems:
            click.echo(f"  Stems ready: {', '.join(stems.available_stems)}")
            analysis_audio = _mix_stem_audio(stems.other, stems.bass)
            if analysis_audio is not None:
                analysis_path = _write_temp_audio(analysis_audio, stems.sr, "_chip_analysis.wav")
                stem_tmp_paths.append(analysis_path)

            melody_audio = stems.vocals if stems.vocals is not None else stems.other
            if melody_audio is not None:
                melody_path = _write_temp_audio(melody_audio, stems.sr, "_chip_melody.wav")
                stem_tmp_paths.append(melody_path)
        else:
            click.echo("  Demucs unavailable or failed; continuing with full-mix analysis")
            click.echo(f"  Install stems: {_optional_dependency_install_hint('stems')}")

    try:
        click.echo("  Tempo/key/chroma/melody analysis...")
        result = generate_chiptune_cover(
            analysis_path,
            melody_path=melody_path,
            duration_seconds=duration,
            seed=seed,
            sample_rate=sample_rate,
            bit_depth=bit_depth,
            chip_rate=chip_rate,
        )
    except ValueError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)
    finally:
        for path in stem_tmp_paths:
            path.unlink(missing_ok=True)

    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    stem_name = f"{input_path.stem}_chiptune"

    click.echo(
        f"  Key: {result.key}  BPM: {result.bpm:.1f}  "
        f"Duration: {result.rendered_duration_seconds:.1f}s"
    )
    click.echo(
        f"  Melody notes: {result.melody_note_count}  "
        f"Chords: {', '.join(chord.name for chord in result.chord_events[:8])}"
    )
    click.echo("  Rendering + mastering...")
    for fmt, path in export_audio(result.audio, result.sample_rate, out_path / stem_name, formats=formats).items():
        click.echo(f"  {fmt.upper():<5} → {path}")


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


def _resolve_slowed_reverb_preset(value: Optional[str]):
    if not value:
        return None

    from .core.neural_ambient import get_slowed_reverb_preset, random_slowed_reverb_preset

    if value.strip().lower() == "random":
        return random_slowed_reverb_preset()
    return get_slowed_reverb_preset(value)


def _resolve_slowed_reverb_preset_choices(value: Optional[str], random_choices: bool) -> list:
    from .core.neural_ambient import get_slowed_reverb_preset, list_slowed_reverb_presets

    if value and random_choices:
        raise ValueError("Use either --slowed-reverb-preset or --random-slowed-reverb-presets, not both")

    if random_choices or (value and value.strip().lower() == "random"):
        return list(list_slowed_reverb_presets())
    if value:
        return [get_slowed_reverb_preset(value)]
    return []


def _parse_audio_formats(output: str, allowed: set[str]) -> list[str]:
    formats = list(dict.fromkeys(f.strip().lower() for f in output.split(",") if f.strip()))
    if not formats:
        raise ValueError("--output must include at least one format")

    unsupported = [fmt for fmt in formats if fmt not in allowed]
    if unsupported:
        expected = ",".join(sorted(allowed))
        found = ",".join(unsupported)
        raise ValueError(f"unsupported --output format(s): {found}. Expected: {expected}")

    return formats


def _append_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _local_now_label() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


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
