from __future__ import annotations
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def extract_melody(path: str | Path) -> Optional[list[tuple[float, float, int]]]:
    """Return [(start_sec, end_sec, midi_pitch), ...] or None if unavailable."""
    try:
        from basic_pitch.inference import predict
        from basic_pitch import ICASSP_2022_MODEL_PATH

        _, midi_data, _ = predict(str(path), ICASSP_2022_MODEL_PATH)
        if not midi_data.instruments:
            return None

        notes = [
            (n.start, n.end, n.pitch)
            for n in midi_data.instruments[0].notes
        ]
        return notes or None
    except ImportError:
        logger.debug("basic-pitch not installed (pip install lofi-maker[melody])")
        return None
    except Exception as exc:
        logger.warning("Melody extraction failed: %s", exc)
        return None
