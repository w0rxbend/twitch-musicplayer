from __future__ import annotations
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class StemBundle:
    vocals: Optional[np.ndarray]
    drums: Optional[np.ndarray]
    bass: Optional[np.ndarray]
    other: Optional[np.ndarray]
    sr: int

    @property
    def available_stems(self) -> list[str]:
        return [k for k, v in [("vocals", self.vocals), ("drums", self.drums),
                                ("bass", self.bass), ("other", self.other)] if v is not None]


def separate_stems(path: str | Path, model_name: str = "htdemucs") -> Optional[StemBundle]:
    """
    CPU stem separation via Demucs. Expect 5-20 min for a typical 3-4 min song.
    Requires: pip install lofi-maker[stems]
    """
    try:
        import torch
        import torchaudio
        from demucs.pretrained import get_model
        from demucs.apply import apply_model

        logger.info("Loading Demucs %s (CPU — this will take a few minutes)…", model_name)
        model = get_model(model_name)
        model.cpu()
        model.eval()

        waveform, sr = torchaudio.load(str(path))
        if waveform.shape[0] == 1:
            waveform = waveform.repeat(2, 1)

        if sr != model.samplerate:
            waveform = torchaudio.functional.resample(waveform, sr, model.samplerate)

        with torch.no_grad():
            sources = apply_model(model, waveform.unsqueeze(0), device="cpu")[0]

        stem_map: dict[str, np.ndarray] = {
            name: sources[i].mean(0).numpy()
            for i, name in enumerate(model.sources)
        }
        logger.info("Stems separated: %s", list(stem_map.keys()))

        return StemBundle(
            vocals=stem_map.get("vocals"),
            drums=stem_map.get("drums"),
            bass=stem_map.get("bass"),
            other=stem_map.get("other"),
            sr=model.samplerate,
        )

    except ImportError:
        logger.warning("Demucs not available. Install with: pip install lofi-maker[stems]")
        return None
    except Exception as exc:
        logger.error("Stem separation failed: %s", exc)
        return None
