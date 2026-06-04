from __future__ import annotations
import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional
import pretty_midi

logger = logging.getLogger(__name__)

_SF2_SEARCH_PATHS = [
    Path("/usr/share/sounds/sf2/FluidR3_GM.sf2"),
    Path("/usr/share/soundfonts/FluidR3_GM.sf2"),
    Path("/usr/share/soundfonts/default.sf2"),
    Path("/usr/share/sounds/sf2/default.sf2"),
    Path.home() / ".local/share/sounds/sf2/FluidR3_GM.sf2",
]

# pretty_midi bundles a fallback SoundFont
_PRETTY_MIDI_SF2 = Path(__file__).parent.parent.parent.parent / ".venv" / "lib"


def find_soundfont() -> Optional[Path]:
    for p in _SF2_SEARCH_PATHS:
        if p.exists():
            return p
    # Fall back to the SoundFont bundled with pretty_midi
    try:
        import pretty_midi as _pm
        bundled = Path(_pm.__file__).parent / "TimGM6mb.sf2"
        if bundled.exists():
            return bundled
    except Exception:
        pass
    return None


def midi_to_wav(
    midi: pretty_midi.PrettyMIDI,
    output_path: str | Path,
    soundfont: Optional[str | Path] = None,
    sample_rate: int = 44100,
) -> Path:
    output_path = Path(output_path)

    sf2 = Path(soundfont) if soundfont else find_soundfont()
    if sf2 is None:
        raise FileNotFoundError(
            "No SoundFont (.sf2) found.\n"
            "  Ubuntu/Debian: sudo apt install fluid-soundfont-gm\n"
            "  Arch:          sudo pacman -S soundfont-fluid\n"
            "  Or set --soundfont /path/to/file.sf2"
        )

    with tempfile.NamedTemporaryFile(suffix=".mid", delete=False) as tmp:
        mid_path = Path(tmp.name)

    try:
        midi.write(str(mid_path))
        _render_via_cli(mid_path, output_path, sf2, sample_rate)
    finally:
        mid_path.unlink(missing_ok=True)

    logger.debug("Rendered %s", output_path.name)
    return output_path


def _render_via_cli(mid_path: Path, wav_path: Path, sf2: Path, sample_rate: int) -> None:
    """Use the fluidsynth CLI — more reliable than the Python binding on headless systems."""
    if not shutil.which("fluidsynth"):
        raise RuntimeError("fluidsynth CLI not found. Install it: sudo apt install fluidsynth")

    result = subprocess.run(
        [
            "fluidsynth",
            "-ni",                          # non-interactive, no audio playback
            "-F", str(wav_path),            # render directly to file
            "-r", str(sample_rate),
            str(sf2),
            str(mid_path),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=300,
    )
    if not wav_path.exists() or wav_path.stat().st_size == 0:
        # Re-run with captured output only on failure so we can surface the reason
        diag = subprocess.run(
            ["fluidsynth", "-ni", "-F", str(wav_path), "-r", str(sample_rate), str(sf2), str(mid_path)],
            capture_output=True, timeout=300,
        )
        raise RuntimeError(f"fluidsynth render failed:\n{diag.stderr.decode(errors='replace')}")
