from __future__ import annotations
import os
import yaml
from pathlib import Path
from .models import LofiPreset, EffectsConfig, InstrumentsConfig


def _find_presets_dir() -> Path:
    env = os.environ.get("LOFI_MAKER_PRESETS_DIR")
    if env:
        return Path(env)
    dev = Path(__file__).parent.parent.parent.parent / "presets" / "lofi"
    if dev.exists():
        return dev
    cwd = Path.cwd() / "presets" / "lofi"
    if cwd.exists():
        return cwd
    return dev


def load_preset(name: str, presets_dir: Path | None = None) -> LofiPreset:
    base = presets_dir or _find_presets_dir()
    path = base / f"{name}.yaml"
    if not path.exists():
        raise FileNotFoundError(f"Preset not found: {name!r} (looked in {base})")

    with path.open() as f:
        data = yaml.safe_load(f)

    effects_raw = data.pop("effects", {})
    instruments_raw = data.pop("instruments", {})

    if isinstance(data.get("bpm_range"), list):
        data["bpm_range"] = tuple(data["bpm_range"])
    if isinstance(data.get("chord_extensions"), list):
        data["chord_extensions"] = list(data["chord_extensions"])

    preset_fields = LofiPreset.__dataclass_fields__
    effects_fields = EffectsConfig.__dataclass_fields__
    instruments_fields = InstrumentsConfig.__dataclass_fields__

    return LofiPreset(
        **{k: v for k, v in data.items() if k in preset_fields},
        effects=EffectsConfig(**{k: v for k, v in effects_raw.items() if k in effects_fields}),
        instruments=InstrumentsConfig(**{k: v for k, v in instruments_raw.items() if k in instruments_fields}),
    )


def list_presets(presets_dir: Path | None = None) -> list[str]:
    base = presets_dir or _find_presets_dir()
    if not base.exists():
        return []
    return sorted(p.stem for p in base.glob("*.yaml"))
