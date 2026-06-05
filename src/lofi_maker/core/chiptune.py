from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import math
import random
from typing import Iterable

import numpy as np


_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_NOTE_TO_PC = {
    "C": 0,
    "C#": 1,
    "Db": 1,
    "D": 2,
    "D#": 3,
    "Eb": 3,
    "E": 4,
    "F": 5,
    "F#": 6,
    "Gb": 6,
    "G": 7,
    "G#": 8,
    "Ab": 8,
    "A": 9,
    "A#": 10,
    "Bb": 10,
    "B": 11,
}
_MAJOR_SCALE = {0, 2, 4, 5, 7, 9, 11}
_MINOR_SCALE = {0, 2, 3, 5, 7, 8, 10}
_CHORD_QUALITIES = ("major", "minor")


@dataclass(frozen=True)
class ChiptuneNote:
    start: float
    end: float
    pitch: int
    velocity: float = 1.0


@dataclass(frozen=True)
class ChiptuneChord:
    start: float
    end: float
    root: int
    quality: str
    confidence: float = 0.0

    @property
    def name(self) -> str:
        suffix = "m" if self.quality == "minor" else ""
        return f"{_NOTE_NAMES[self.root]}{suffix}"


@dataclass(frozen=True)
class ChiptunePercussionHit:
    start: float
    kind: str
    velocity: float = 1.0


@dataclass(frozen=True)
class ChiptuneCoverResult:
    audio: np.ndarray
    sample_rate: int
    bpm: float
    key: str
    source_duration_seconds: float
    rendered_duration_seconds: float
    melody_note_count: int
    bass_note_count: int
    percussion_hit_count: int
    chord_count: int
    beat_count: int
    chord_events: list[ChiptuneChord]
    melody_events: list[ChiptuneNote]
    bass_events: list[ChiptuneNote]
    percussion_events: list[ChiptunePercussionHit]
    beat_times: np.ndarray


def generate_chiptune_cover(
    input_path: str | Path,
    *,
    melody_path: str | Path | None = None,
    duration_seconds: float | None = None,
    seed: int | None = None,
    sample_rate: int = 44_100,
    bit_depth: int = 8,
    chip_rate: int = 11_025,
    lead_volume: float = 0.42,
    harmony_volume: float = 0.22,
    bass_volume: float = 0.34,
    drum_volume: float = 0.28,
    melody_notes: Iterable[tuple[float, float, int]] | None = None,
) -> ChiptuneCoverResult:
    """Analyze an existing song and resynthesize it as an 8-bit chiptune cover."""
    import librosa

    from ..analysis.melody_extractor import extract_melody
    from ..analysis.song_analyzer import analyze_song

    _validate_render_options(sample_rate, bit_depth, chip_rate)
    input_path = Path(input_path)
    melody_source = Path(melody_path) if melody_path is not None else input_path

    load_duration = None if duration_seconds is None else max(0.1, float(duration_seconds))
    y, analysis_sr = librosa.load(str(input_path), mono=True, sr=22_050, duration=load_duration)
    if y.size == 0:
        raise ValueError("input audio is empty")

    source_duration = float(len(y) / analysis_sr)
    target_duration = source_duration if duration_seconds is None else min(source_duration, load_duration or source_duration)
    target_duration = max(0.1, target_duration)

    context = analyze_song(input_path, duration_seconds=target_duration, seed=seed)
    fallback_bpm = _sanitize_bpm(context.source_bpm or context.bpm)
    key = context.key

    harmonic, percussive = _split_harmonic_percussive(y)
    bpm = _estimate_source_bpm(percussive, analysis_sr, fallback_bpm)
    beat_times = _detect_beat_times(percussive, analysis_sr, bpm, target_duration)
    chord_events = _extract_chord_events(harmonic, analysis_sr, target_duration, beat_times, key, bpm)
    bass_events = _extract_bass_events(harmonic, analysis_sr, target_duration, bpm)
    percussion_events = _extract_percussion_hits(percussive, analysis_sr, target_duration, beat_times, bpm)

    source_notes = list(melody_notes) if melody_notes is not None else extract_melody(melody_source)
    melody_events = _fit_melody_notes(source_notes or [], bpm, target_duration, key)
    if _melody_is_sparse(melody_events, target_duration):
        detected_melody = _extract_salient_melody_events(harmonic, analysis_sr, target_duration, bpm, key)
        melody_events = _combine_melody_events(melody_events, detected_melody, bpm, target_duration)
    if not melody_events:
        melody_events = _fallback_melody_from_chords(chord_events, beat_times, bpm, target_duration, seed)

    audio = synthesize_chiptune_cover(
        chord_events=chord_events,
        melody_events=melody_events,
        beat_times=beat_times,
        bpm=bpm,
        duration_seconds=target_duration,
        sample_rate=sample_rate,
        bit_depth=bit_depth,
        chip_rate=chip_rate,
        lead_volume=lead_volume,
        harmony_volume=harmony_volume,
        bass_volume=bass_volume,
        drum_volume=drum_volume,
        bass_events=bass_events,
        percussion_events=percussion_events,
        seed=seed,
    )

    return ChiptuneCoverResult(
        audio=audio,
        sample_rate=sample_rate,
        bpm=bpm,
        key=key,
        source_duration_seconds=source_duration,
        rendered_duration_seconds=target_duration,
        melody_note_count=len(melody_events),
        bass_note_count=len(bass_events),
        percussion_hit_count=len(percussion_events),
        chord_count=len(chord_events),
        beat_count=len(beat_times),
        chord_events=chord_events,
        melody_events=melody_events,
        bass_events=bass_events,
        percussion_events=percussion_events,
        beat_times=beat_times,
    )


def synthesize_chiptune_cover(
    *,
    chord_events: list[ChiptuneChord],
    melody_events: list[ChiptuneNote],
    beat_times: np.ndarray,
    bpm: float,
    duration_seconds: float,
    sample_rate: int = 44_100,
    bit_depth: int = 8,
    chip_rate: int = 11_025,
    lead_volume: float = 0.42,
    harmony_volume: float = 0.22,
    bass_volume: float = 0.34,
    drum_volume: float = 0.28,
    bass_events: list[ChiptuneNote] | None = None,
    percussion_events: list[ChiptunePercussionHit] | None = None,
    seed: int | None = None,
) -> np.ndarray:
    """Render extracted song events with classic chip-style voices."""
    _validate_render_options(sample_rate, bit_depth, chip_rate)
    duration_seconds = max(0.1, float(duration_seconds))
    bpm = _sanitize_bpm(bpm)
    beat = 60.0 / bpm
    n_samples = max(1, int(round(duration_seconds * sample_rate)))
    mix = np.zeros((n_samples, 2), dtype=np.float32)
    rng = np.random.default_rng(seed)

    if chord_events:
        _render_harmony(mix, chord_events, beat, sample_rate, harmony_volume)

    if chord_events or bass_events:
        _render_bass(
            mix,
            chord_events,
            beat_times,
            beat,
            duration_seconds,
            sample_rate,
            bass_volume,
            bass_events=bass_events,
        )

    _render_lead(mix, melody_events, beat, duration_seconds, sample_rate, lead_volume)

    _render_drums(
        mix,
        beat_times,
        beat,
        duration_seconds,
        sample_rate,
        drum_volume,
        rng,
        percussion_events=percussion_events,
    )
    mix = _soft_limit(mix)
    mix = _bitcrush(mix, sample_rate, bit_depth=bit_depth, chip_rate=chip_rate)
    mix = _fade_edges(mix, sample_rate)
    return np.clip(mix, -1.0, 1.0).astype(np.float32)


def _split_harmonic_percussive(y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    try:
        import librosa

        harmonic, percussive = librosa.effects.hpss(y)
        return harmonic.astype(np.float32), percussive.astype(np.float32)
    except Exception:
        return y.astype(np.float32), y.astype(np.float32)


def _estimate_source_bpm(percussive: np.ndarray, sr: int, fallback_bpm: float) -> float:
    try:
        import librosa

        hop_length = 512
        onset_env = librosa.onset.onset_strength(y=percussive, sr=sr, hop_length=hop_length)
        tempo_fn = getattr(librosa.feature, "tempo", None) or getattr(librosa.beat, "tempo")
        tempo_values = tempo_fn(onset_envelope=onset_env, sr=sr, hop_length=hop_length, aggregate=None)
        candidates = [fallback_bpm]
        candidates.extend(float(value) for value in np.ravel(tempo_values) if np.isfinite(value))
    except Exception:
        return _sanitize_bpm(fallback_bpm)

    expanded: list[float] = []
    for candidate in candidates:
        for multiplier in (0.5, 1.0, 2.0):
            value = float(candidate) * multiplier
            if 45.0 <= value <= 220.0:
                expanded.append(value)

    if not expanded:
        return _sanitize_bpm(fallback_bpm)

    unique_candidates = sorted(set(round(value, 2) for value in expanded))
    best = max(
        unique_candidates,
        key=lambda value: (
            _score_bpm_against_onsets(value, onset_env, sr, hop_length),
            -abs(math.log2(value / fallback_bpm)) if fallback_bpm > 0 else 0.0,
        ),
    )
    return _sanitize_bpm(best)


def _score_bpm_against_onsets(bpm: float, onset_env: np.ndarray, sr: int, hop_length: int) -> float:
    if onset_env.size == 0 or bpm <= 0:
        return 0.0

    frames_per_second = sr / hop_length
    beat_frames = max(1.0, 60.0 / bpm * frames_per_second)
    normalized = np.asarray(onset_env, dtype=np.float32)
    peak = float(np.max(normalized)) if normalized.size else 0.0
    if peak > 1e-6:
        normalized = normalized / peak

    best = 0.0
    for offset in np.linspace(0.0, beat_frames, num=8, endpoint=False):
        starts = np.arange(offset, len(onset_env), beat_frames)
        if starts.size == 0:
            continue
        indices = np.clip(np.round(starts).astype(int), 0, len(onset_env) - 1)
        best = max(best, float(np.mean(normalized[indices])))
    return best


def _detect_beat_times(
    percussive: np.ndarray,
    sr: int,
    bpm: float,
    duration_seconds: float,
) -> np.ndarray:
    import librosa

    try:
        _, beats = librosa.beat.beat_track(y=percussive, sr=sr, units="time", trim=False)
        beat_times = np.asarray(beats, dtype=np.float32)
        beat_times = beat_times[(beat_times >= 0.0) & (beat_times < duration_seconds)]
    except Exception:
        beat_times = np.zeros(0, dtype=np.float32)

    beat_period = 60.0 / _sanitize_bpm(bpm)
    if beat_times.size < 4:
        return _regular_beat_grid(duration_seconds, beat_period)

    if beat_times[0] > beat_period * 0.5:
        prefix = np.arange(0.0, float(beat_times[0]), beat_period, dtype=np.float32)
        beat_times = np.concatenate([prefix, beat_times])

    if duration_seconds - beat_times[-1] > beat_period * 1.5:
        suffix = np.arange(float(beat_times[-1]) + beat_period, duration_seconds, beat_period, dtype=np.float32)
        beat_times = np.concatenate([beat_times, suffix])

    return np.unique(np.round(beat_times, 4)).astype(np.float32)


def _extract_chord_events(
    harmonic: np.ndarray,
    sr: int,
    duration_seconds: float,
    beat_times: np.ndarray,
    key: str,
    bpm: float,
) -> list[ChiptuneChord]:
    import librosa
    import scipy.ndimage

    root_from_key = _root_pc_from_key(key)
    mode = "minor" if _key_is_minor(key) else "major"
    boundaries = _chord_boundaries(beat_times, duration_seconds, fallback_bpm=bpm)

    try:
        chroma = librosa.feature.chroma_cqt(y=harmonic, sr=sr, hop_length=512)
        chroma = scipy.ndimage.median_filter(chroma, size=(1, 5))
        times = librosa.times_like(chroma, sr=sr, hop_length=512)
    except Exception:
        chroma = np.zeros((12, 0), dtype=np.float32)
        times = np.zeros(0, dtype=np.float32)

    events: list[ChiptuneChord] = []
    for start, end in zip(boundaries[:-1], boundaries[1:]):
        if end <= start:
            continue

        if chroma.size:
            mask = (times >= start) & (times < end)
            vector = np.median(chroma[:, mask], axis=1) if np.any(mask) else np.zeros(12)
        else:
            vector = np.zeros(12)

        root, quality, confidence = _infer_chord_from_chroma(
            vector,
            key,
            mode,
            previous=events[-1] if events else None,
        )

        events.append(ChiptuneChord(float(start), float(end), root, quality, confidence))

    return _merge_repeated_chords(events) or [
        ChiptuneChord(0.0, duration_seconds, root_from_key, mode, 0.0)
    ]


def _fit_melody_notes(
    notes: Iterable[tuple[float, float, int]],
    bpm: float,
    duration_seconds: float,
    key: str,
) -> list[ChiptuneNote]:
    beat = 60.0 / _sanitize_bpm(bpm)
    grid = beat / 8.0
    fitted_by_slot: dict[int, ChiptuneNote] = {}

    for raw_start, raw_end, raw_pitch in notes:
        start = max(0.0, float(raw_start))
        end = max(start + 0.05, float(raw_end))
        if start >= duration_seconds:
            continue

        q_start = round(start / grid) * grid
        q_end = round(end / grid) * grid
        q_start = max(0.0, min(duration_seconds, q_start))
        q_end = min(duration_seconds, max(q_start + grid * 0.6, q_end))
        if q_end <= q_start:
            continue

        pitch = _fold_pitch(int(round(raw_pitch)), low=55, high=96)
        note = ChiptuneNote(q_start, q_end, pitch, velocity=1.0)
        slot = int(round(q_start / grid))
        previous = fitted_by_slot.get(slot)
        if previous is None or _melody_note_priority(note) > _melody_note_priority(previous):
            fitted_by_slot[slot] = note

    return _merge_melody_notes(sorted(fitted_by_slot.values(), key=lambda item: (item.start, item.pitch)), grid * 0.5)


def _extract_salient_melody_events(
    harmonic: np.ndarray,
    sr: int,
    duration_seconds: float,
    bpm: float,
    key: str,
) -> list[ChiptuneNote]:
    try:
        import librosa

        hop_length = 256
        pitches, magnitudes = librosa.piptrack(
            y=harmonic,
            sr=sr,
            hop_length=hop_length,
            fmin=librosa.note_to_hz("G2"),
            fmax=librosa.note_to_hz("C7"),
            threshold=0.05,
        )
        times = librosa.times_like(magnitudes, sr=sr, hop_length=hop_length)
    except Exception:
        return []

    if magnitudes.size == 0 or pitches.size == 0:
        return []

    frame_strengths = np.max(magnitudes, axis=0)
    nonzero = frame_strengths[frame_strengths > 0.0]
    if nonzero.size == 0:
        return []

    strength_floor = max(float(np.percentile(nonzero, 45)) * 0.55, float(np.max(nonzero)) * 0.035)
    raw_notes: list[tuple[float, float, int]] = []
    current_start: float | None = None
    current_pitch: int | None = None
    frame_step = float(times[1] - times[0]) if len(times) > 1 else 0.03

    for frame_index, time in enumerate(times):
        if float(time) >= duration_seconds:
            break

        column = magnitudes[:, frame_index]
        peak_index = int(np.argmax(column))
        strength = float(column[peak_index])
        freq = float(pitches[peak_index, frame_index])
        pitch = None
        if strength >= strength_floor and np.isfinite(freq) and freq > 0.0:
            pitch = _fold_pitch(int(round(_hz_to_midi(freq))), low=55, high=96)

        if pitch is None:
            if current_start is not None and current_pitch is not None:
                _append_raw_note(raw_notes, current_start, float(time), current_pitch, min_duration=0.045)
            current_start = None
            current_pitch = None
            continue

        if current_pitch is None:
            current_start = float(time)
            current_pitch = pitch
        elif abs(pitch - current_pitch) <= 1:
            current_pitch = int(round((current_pitch + pitch) / 2))
        else:
            _append_raw_note(raw_notes, current_start or 0.0, float(time), current_pitch, min_duration=0.045)
            current_start = float(time)
            current_pitch = pitch

    if current_start is not None and current_pitch is not None:
        end = min(duration_seconds, float(times[-1] + frame_step) if len(times) else duration_seconds)
        _append_raw_note(raw_notes, current_start, end, current_pitch, min_duration=0.045)

    fitted = _fit_melody_notes(raw_notes, bpm, duration_seconds, key)
    return _limit_event_density(fitted, max_events_per_second=14.0, duration_seconds=duration_seconds)


def _append_raw_note(
    notes: list[tuple[float, float, int]],
    start: float,
    end: float,
    pitch: int,
    *,
    min_duration: float,
) -> None:
    if end - start >= min_duration:
        notes.append((start, max(end, start + min_duration), pitch))


def _melody_is_sparse(notes: list[ChiptuneNote], duration_seconds: float) -> bool:
    if not notes:
        return True
    expected = max(4, int(duration_seconds * 1.4))
    covered = sum(max(0.0, min(note.end, duration_seconds) - max(0.0, note.start)) for note in notes)
    return len(notes) < expected or covered < duration_seconds * 0.18


def _combine_melody_events(
    primary: list[ChiptuneNote],
    supplemental: list[ChiptuneNote],
    bpm: float,
    duration_seconds: float,
) -> list[ChiptuneNote]:
    if not supplemental:
        return primary
    if not primary:
        return supplemental

    beat = 60.0 / _sanitize_bpm(bpm)
    tolerance = beat / 8.0
    combined = list(primary)
    for note in supplemental:
        if note.start >= duration_seconds:
            continue
        if any(_notes_overlap(note, existing, tolerance=tolerance) for existing in combined):
            continue
        combined.append(note)

    combined.sort(key=lambda item: (item.start, -item.pitch))
    return _limit_event_density(combined, max_events_per_second=14.0, duration_seconds=duration_seconds)


def _notes_overlap(a: ChiptuneNote, b: ChiptuneNote, *, tolerance: float) -> bool:
    return a.start < b.end + tolerance and b.start < a.end + tolerance


def _melody_note_priority(note: ChiptuneNote) -> float:
    duration = max(0.0, note.end - note.start)
    pitch_weight = (note.pitch - 55) / 41.0
    return duration * 0.68 + note.velocity * 0.18 + pitch_weight * 0.14


def _extract_bass_events(
    harmonic: np.ndarray,
    sr: int,
    duration_seconds: float,
    bpm: float,
) -> list[ChiptuneNote]:
    try:
        import librosa

        f0, voiced_flag, voiced_probability = librosa.pyin(
            harmonic,
            fmin=librosa.note_to_hz("E1"),
            fmax=librosa.note_to_hz("C4"),
            sr=sr,
            frame_length=2048,
            hop_length=512,
        )
        if f0 is None or voiced_flag is None:
            return []

        times = librosa.times_like(f0, sr=sr, hop_length=512)
        probabilities = (
            np.nan_to_num(voiced_probability, nan=0.0).astype(np.float32)
            if voiced_probability is not None
            else np.ones_like(f0, dtype=np.float32)
        )
    except Exception:
        return []

    beat = 60.0 / _sanitize_bpm(bpm)
    grid = beat / 8.0
    notes: list[ChiptuneNote] = []
    current_start: float | None = None
    current_pitch: int | None = None
    current_velocity = 0.0
    frame_step = float(times[1] - times[0]) if len(times) > 1 else grid

    for time, freq, voiced, probability in zip(times, f0, voiced_flag, probabilities):
        if float(time) >= duration_seconds:
            break

        pitch = None
        if voiced and np.isfinite(freq) and probability >= 0.12:
            pitch = _fold_pitch(int(round(_hz_to_midi(float(freq)))), low=36, high=55)

        if pitch is None:
            if current_start is not None and current_pitch is not None:
                _append_bass_note(
                    notes,
                    current_start,
                    float(time),
                    current_pitch,
                    current_velocity,
                    grid,
                    duration_seconds,
                )
            current_start = None
            current_pitch = None
            current_velocity = 0.0
            continue

        velocity = float(np.clip(0.45 + probability * 0.55, 0.35, 1.0))
        if current_pitch is None:
            current_start = float(time)
            current_pitch = pitch
            current_velocity = velocity
        elif abs(pitch - current_pitch) <= 1:
            current_pitch = int(round((current_pitch + pitch) / 2))
            current_velocity = max(current_velocity, velocity)
        else:
            _append_bass_note(
                notes,
                current_start or 0.0,
                float(time),
                current_pitch,
                current_velocity,
                grid,
                duration_seconds,
            )
            current_start = float(time)
            current_pitch = pitch
            current_velocity = velocity

    if current_start is not None and current_pitch is not None:
        end = min(duration_seconds, float(times[-1] + frame_step) if len(times) else duration_seconds)
        _append_bass_note(notes, current_start, end, current_pitch, current_velocity, grid, duration_seconds)

    return _limit_event_density(
        _merge_melody_notes(notes, max_gap=grid * 0.75),
        max_events_per_second=12.0,
        duration_seconds=duration_seconds,
    )


def _append_bass_note(
    notes: list[ChiptuneNote],
    start: float,
    end: float,
    pitch: int,
    velocity: float,
    grid: float,
    duration_seconds: float,
) -> None:
    if end - start < 0.055:
        return

    q_start = max(0.0, min(duration_seconds, round(start / grid) * grid))
    q_end = min(duration_seconds, max(q_start + grid * 0.55, round(end / grid) * grid))
    if q_end > q_start:
        notes.append(
            ChiptuneNote(
                float(q_start),
                float(q_end),
                pitch,
                float(np.clip(velocity, 0.25, 1.0)),
            )
        )


def _extract_percussion_hits(
    percussive: np.ndarray,
    sr: int,
    duration_seconds: float,
    beat_times: np.ndarray,
    bpm: float,
) -> list[ChiptunePercussionHit]:
    try:
        import librosa

        hop_length = 512
        onset_env = librosa.onset.onset_strength(y=percussive, sr=sr, hop_length=hop_length)
        if onset_env.size == 0:
            return []

        onset_times = librosa.onset.onset_detect(
            onset_envelope=onset_env,
            sr=sr,
            hop_length=hop_length,
            units="time",
            backtrack=True,
            delta=0.02,
            wait=0,
        )
    except Exception:
        return []

    if len(onset_times) == 0:
        return []

    strengths = np.asarray(onset_env, dtype=np.float32)
    strength_floor = float(np.percentile(strengths, 42)) if strengths.size else 0.0
    strength_peak = float(np.percentile(strengths, 96)) if strengths.size else 1.0
    scale = max(1e-6, strength_peak - strength_floor)
    beat = 60.0 / _sanitize_bpm(bpm)
    hits: list[ChiptunePercussionHit] = []

    for start in onset_times:
        start = float(start)
        if start < 0.0 or start >= duration_seconds:
            continue

        frame = min(len(strengths) - 1, max(0, int(round(start * sr / hop_length)))) if strengths.size else 0
        raw_strength = float(strengths[frame]) if strengths.size else 1.0
        if raw_strength < strength_floor and not _is_near_any_beat(start, beat_times, tolerance=beat * 0.16):
            continue

        velocity = float(np.clip(0.34 + (raw_strength - strength_floor) / scale * 0.66, 0.22, 1.0))
        kind = _classify_percussion_hit(percussive, sr, start, beat_times, bpm)
        hits.append(ChiptunePercussionHit(start, kind, velocity))

    return _limit_percussion_density(_merge_close_percussion_hits(hits), duration_seconds)


def _classify_percussion_hit(
    percussive: np.ndarray,
    sr: int,
    start: float,
    beat_times: np.ndarray,
    bpm: float,
) -> str:
    window_start = max(0, int(round(start * sr)))
    window_end = min(len(percussive), window_start + max(1, int(sr * 0.09)))
    if window_end <= window_start:
        return _percussion_kind_from_position(start, beat_times, bpm)

    segment = percussive[window_start:window_end].astype(np.float32)
    if segment.size < 8:
        return _percussion_kind_from_position(start, beat_times, bpm)

    spectrum = np.abs(np.fft.rfft(segment * np.hanning(segment.size))).astype(np.float32)
    freqs = np.fft.rfftfreq(segment.size, d=1.0 / sr)
    total = float(np.sum(spectrum)) + 1e-6
    low = float(np.sum(spectrum[(freqs >= 35.0) & (freqs <= 180.0)])) / total
    mid = float(np.sum(spectrum[(freqs > 180.0) & (freqs <= 2_400.0)])) / total
    high = float(np.sum(spectrum[freqs > 2_400.0])) / total

    if low > 0.30 and low > high * 1.15:
        return "kick"
    if high > 0.48 and high > mid * 0.9:
        return "hat"
    if mid > 0.24 or high > 0.28:
        return "snare"
    return _percussion_kind_from_position(start, beat_times, bpm)


def _percussion_kind_from_position(start: float, beat_times: np.ndarray, bpm: float) -> str:
    beat = 60.0 / _sanitize_bpm(bpm)
    if beat_times.size:
        index = int(np.argmin(np.abs(beat_times - start)))
        distance = abs(float(beat_times[index]) - start)
        if distance <= beat * 0.18:
            return "kick" if index % 4 in (0, 2) else "snare"
    return "hat"


def _fallback_melody_from_chords(
    chords: list[ChiptuneChord],
    beat_times: np.ndarray,
    bpm: float,
    duration_seconds: float,
    seed: int | None,
) -> list[ChiptuneNote]:
    rng = random.Random(seed)
    beat = 60.0 / _sanitize_bpm(bpm)
    beats = beat_times if beat_times.size >= 4 else _regular_beat_grid(duration_seconds, beat)
    notes: list[ChiptuneNote] = []
    pattern = [0, 7, 12, 7, 3, 7, 10, 7]

    for index, start in enumerate(beats):
        if start >= duration_seconds:
            continue
        if index % 2 == 1 and rng.random() > 0.35:
            continue
        chord = _chord_at(chords, float(start))
        third = 3 if chord.quality == "minor" else 4
        interval = pattern[index % len(pattern)]
        if interval == 3:
            interval = third
        pitch = _fold_pitch(60 + chord.root + interval, low=60, high=84)
        notes.append(ChiptuneNote(float(start), min(duration_seconds, float(start) + beat * 0.7), pitch, 0.78))

    return notes


def _render_harmony(
    mix: np.ndarray,
    chords: list[ChiptuneChord],
    beat: float,
    sr: int,
    volume: float,
) -> None:
    step = max(beat / 4.0, 0.06)
    pattern = (0, 1, 2, 1, 3, 2, 1, 2)
    for chord in chords:
        pitches = _chord_pitches(chord, octave=4)
        t = chord.start
        index = 0
        while t < chord.end:
            pitch = pitches[pattern[index % len(pattern)] % len(pitches)]
            accent = 1.0 if index % 4 == 0 else 0.78
            _add_note(
                mix,
                sr,
                start=t,
                end=min(chord.end, t + step * 0.72),
                pitch=pitch,
                volume=volume * 0.46 * accent,
                waveform="pulse",
                pan=0.30 if index % 2 == 0 else 0.18,
                duty=0.125 if index % 4 == 2 else 0.25,
                attack=0.002,
                release=0.012,
            )
            t += step
            index += 1


def _render_bass(
    mix: np.ndarray,
    chords: list[ChiptuneChord],
    beat_times: np.ndarray,
    beat: float,
    duration_seconds: float,
    sr: int,
    volume: float,
    *,
    bass_events: list[ChiptuneNote] | None = None,
) -> None:
    if bass_events:
        for index, note in enumerate(bass_events):
            _add_note(
                mix,
                sr,
                start=note.start,
                end=note.end,
                pitch=_fold_pitch(note.pitch, low=36, high=55),
                volume=volume * note.velocity * (0.95 if index % 4 == 0 else 0.82),
                waveform="triangle",
                pan=-0.14,
                attack=0.002,
                release=0.026,
            )
        if not chords:
            return

    beats = beat_times if beat_times.size >= 4 else _regular_beat_grid(duration_seconds, beat)
    support_volume = volume * (0.42 if bass_events else 1.0)
    for index, start in enumerate(beats):
        if start >= duration_seconds:
            continue
        if index % 4 not in (0, 2, 3):
            continue
        if bass_events and _has_event_near(bass_events, float(start), tolerance=beat * 0.35):
            continue

        chord = _chord_at(chords, float(start))
        interval = 7 if index % 4 == 3 else 0
        pitch = _fold_pitch(36 + chord.root + interval, low=36, high=52)
        length = beat * (0.62 if index % 4 == 3 else 0.92)
        _add_note(
            mix,
            sr,
            start=float(start),
            end=min(duration_seconds, float(start) + length),
            pitch=pitch,
            volume=support_volume,
            waveform="triangle",
            pan=-0.12,
            attack=0.003,
            release=0.035,
        )

        if index % 4 == 3:
            next_chord = _chord_at(chords, min(duration_seconds, float(start) + beat))
            if next_chord.root != chord.root:
                pickup_pitch = _fold_pitch(36 + next_chord.root, low=36, high=52)
                pickup_start = float(start) + beat * 0.72
                _add_note(
                    mix,
                    sr,
                    start=pickup_start,
                    end=min(duration_seconds, pickup_start + beat * 0.24),
                    pitch=pickup_pitch,
                    volume=support_volume * 0.54,
                    waveform="triangle",
                    pan=-0.08,
                    attack=0.002,
                    release=0.018,
                )


def _render_lead(
    mix: np.ndarray,
    melody_events: list[ChiptuneNote],
    beat: float,
    duration_seconds: float,
    sr: int,
    volume: float,
) -> None:
    grid = max(beat / 4.0, 0.05)
    for index, note in enumerate(melody_events):
        note_length = max(0.0, note.end - note.start)
        pan = -0.28 if index % 2 == 0 else 0.24
        duty = 0.50 if index % 3 else 0.25
        accent = 1.08 if _is_near_grid(note.start, beat) else 0.94
        _add_note(
            mix,
            sr,
            start=note.start,
            end=note.end,
            pitch=note.pitch,
            volume=volume * note.velocity * accent,
            waveform="square",
            pan=pan,
            duty=duty,
            attack=0.003,
            release=0.025,
        )

        if note_length >= grid * 2.2:
            sparkle_start = note.start + min(note_length * 0.58, grid * 2.0)
            sparkle_end = min(note.end, sparkle_start + grid * 0.45)
            if sparkle_end - sparkle_start > 0.035:
                _add_note(
                    mix,
                    sr,
                    start=sparkle_start,
                    end=sparkle_end,
                    pitch=_fold_pitch(note.pitch + 12, low=60, high=96),
                    volume=volume * note.velocity * 0.22,
                    waveform="pulse",
                    pan=-pan * 0.8,
                    duty=0.125,
                    attack=0.001,
                    release=0.012,
                )

        if index + 1 < len(melody_events):
            next_note = melody_events[index + 1]
            gap = next_note.start - note.end
            if grid * 1.15 <= gap <= beat * 1.5:
                pickup_start = max(note.end, next_note.start - grid * 0.72)
                pickup_end = min(next_note.start, pickup_start + grid * 0.38)
                if pickup_end - pickup_start > 0.03:
                    pickup_pitch = _fold_pitch(next_note.pitch - 12, low=60, high=84)
                    _add_note(
                        mix,
                        sr,
                        start=pickup_start,
                        end=pickup_end,
                        pitch=pickup_pitch,
                        volume=volume * next_note.velocity * 0.18,
                        waveform="pulse",
                        pan=pan * 0.45,
                        duty=0.25,
                        attack=0.001,
                        release=0.01,
                    )


def _render_drums(
    mix: np.ndarray,
    beat_times: np.ndarray,
    beat: float,
    duration_seconds: float,
    sr: int,
    volume: float,
    rng: np.random.Generator,
    *,
    percussion_events: list[ChiptunePercussionHit] | None = None,
) -> None:
    if percussion_events:
        for hit in percussion_events:
            _add_drum_hit(mix, sr, hit.start, hit.kind, volume * hit.velocity, rng)

    beats = beat_times if beat_times.size >= 4 else _regular_beat_grid(duration_seconds, beat)
    support_volume = volume * (0.38 if percussion_events else 1.0)
    for index, start in enumerate(beats):
        if start >= duration_seconds:
            continue
        beat_in_bar = index % 4
        if not _has_percussion_near(percussion_events, float(start), tolerance=beat * 0.18):
            if beat_in_bar in (0, 2):
                _add_kick(mix, sr, float(start), support_volume * 0.92)
            if beat_in_bar in (1, 3):
                _add_noise_hit(mix, sr, float(start), 0.12, support_volume * 0.82, rng, mode="snare", pan=0.12)

        hat_start = float(start) + beat * 0.5
        if hat_start < duration_seconds and not _has_percussion_near(percussion_events, hat_start, tolerance=beat * 0.14):
            _add_noise_hit(mix, sr, hat_start, 0.035, support_volume * 0.32, rng, mode="hat", pan=-0.22)

        if beat_in_bar == 3:
            fill_start = float(start) + beat * 0.75
            if fill_start < duration_seconds and not _has_percussion_near(percussion_events, fill_start, tolerance=beat * 0.12):
                _add_noise_hit(mix, sr, fill_start, 0.028, support_volume * 0.22, rng, mode="hat", pan=0.24)


def _add_drum_hit(
    mix: np.ndarray,
    sr: int,
    start: float,
    kind: str,
    volume: float,
    rng: np.random.Generator,
) -> None:
    if kind == "kick":
        _add_kick(mix, sr, start, volume * 0.98)
    elif kind == "snare":
        _add_noise_hit(mix, sr, start, 0.11, volume * 0.82, rng, mode="snare", pan=0.12)
    else:
        _add_noise_hit(mix, sr, start, 0.035, volume * 0.46, rng, mode="hat", pan=-0.18)


def _add_note(
    mix: np.ndarray,
    sr: int,
    *,
    start: float,
    end: float,
    pitch: int,
    volume: float,
    waveform: str,
    pan: float = 0.0,
    duty: float = 0.5,
    attack: float = 0.003,
    release: float = 0.02,
) -> None:
    start_i = max(0, int(round(start * sr)))
    end_i = min(mix.shape[0], int(round((end + release) * sr)))
    if end_i <= start_i:
        return

    length = end_i - start_i
    freq = _midi_to_hz(pitch)
    t = np.arange(length, dtype=np.float32) / sr
    wave = _oscillator(t, freq, waveform=waveform, duty=duty)
    env = _note_envelope(length, sr, max(0.001, end - start), attack=attack, release=release)
    signal = (wave * env * volume).astype(np.float32)
    _add_stereo(mix, start_i, signal, pan)


def _add_kick(mix: np.ndarray, sr: int, start: float, volume: float) -> None:
    start_i = max(0, int(round(start * sr)))
    length = min(mix.shape[0] - start_i, int(sr * 0.16))
    if length <= 0:
        return

    t = np.arange(length, dtype=np.float32) / sr
    freq = 92.0 * np.exp(-t * 18.0) + 36.0
    phase = 2.0 * np.pi * np.cumsum(freq) / sr
    env = np.exp(-t * 16.0).astype(np.float32)
    signal = np.sign(np.sin(phase)).astype(np.float32) * env * volume
    _add_stereo(mix, start_i, signal, pan=0.0)


def _add_noise_hit(
    mix: np.ndarray,
    sr: int,
    start: float,
    duration: float,
    volume: float,
    rng: np.random.Generator,
    *,
    mode: str,
    pan: float,
) -> None:
    start_i = max(0, int(round(start * sr)))
    length = min(mix.shape[0] - start_i, max(1, int(sr * duration)))
    if length <= 0:
        return

    t = np.arange(length, dtype=np.float32) / sr
    noise = rng.choice(np.array([-1.0, 1.0], dtype=np.float32), size=length)
    env_rate = 32.0 if mode == "hat" else 18.0
    env = np.exp(-t * env_rate).astype(np.float32)
    signal = noise * env * volume
    if mode == "hat":
        signal = np.concatenate([signal[:1], np.diff(signal)]).astype(np.float32)
    _add_stereo(mix, start_i, signal, pan=pan)


def _add_stereo(mix: np.ndarray, start_i: int, signal: np.ndarray, pan: float) -> None:
    end_i = min(mix.shape[0], start_i + len(signal))
    if end_i <= start_i:
        return

    signal = signal[:end_i - start_i]
    pan = max(-1.0, min(1.0, pan))
    left = math.sqrt((1.0 - pan) * 0.5)
    right = math.sqrt((1.0 + pan) * 0.5)
    mix[start_i:end_i, 0] += signal * left
    mix[start_i:end_i, 1] += signal * right


def _oscillator(t: np.ndarray, freq: float, *, waveform: str, duty: float = 0.5) -> np.ndarray:
    try:
        from scipy import signal

        phase = 2.0 * np.pi * freq * t
        if waveform in {"square", "pulse"}:
            return signal.square(phase, duty=max(0.05, min(0.95, duty))).astype(np.float32)
        if waveform == "triangle":
            return signal.sawtooth(phase, width=0.5).astype(np.float32)
    except Exception:
        pass

    phase_cycles = (freq * t) % 1.0
    if waveform == "triangle":
        return (4.0 * np.abs(phase_cycles - 0.5) - 1.0).astype(np.float32)
    return np.where(phase_cycles < duty, 1.0, -1.0).astype(np.float32)


def _note_envelope(
    length: int,
    sr: int,
    held_seconds: float,
    *,
    attack: float,
    release: float,
) -> np.ndarray:
    env = np.ones(length, dtype=np.float32)
    attack_len = min(length, max(1, int(sr * attack)))
    release_len = min(length, max(1, int(sr * release)))
    held_len = min(length, max(1, int(sr * held_seconds)))

    env[:attack_len] = np.linspace(0.0, 1.0, attack_len, dtype=np.float32)
    if held_len < length:
        tail_len = length - held_len
        env[held_len:] = np.linspace(1.0, 0.0, tail_len, dtype=np.float32)
    else:
        env[-release_len:] *= np.linspace(1.0, 0.0, release_len, dtype=np.float32)
    return env


def _bitcrush(audio: np.ndarray, sr: int, *, bit_depth: int, chip_rate: int) -> np.ndarray:
    crushed = np.asarray(audio, dtype=np.float32).copy()
    hold = max(1, int(round(sr / chip_rate)))
    if hold > 1:
        usable = (crushed.shape[0] // hold) * hold
        if usable > 0:
            held = np.repeat(crushed[:usable:hold], hold, axis=0)
            crushed[:usable] = held[:usable]

    levels = float(2 ** bit_depth - 1)
    crushed = np.round((np.clip(crushed, -1.0, 1.0) + 1.0) * 0.5 * levels) / levels
    return (crushed * 2.0 - 1.0).astype(np.float32)


def _soft_limit(audio: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 0.96:
        audio = audio / peak * 0.96
    return np.tanh(audio * 1.25).astype(np.float32) * 0.88


def _fade_edges(audio: np.ndarray, sr: int, fade_seconds: float = 0.025) -> np.ndarray:
    fade_len = min(audio.shape[0] // 2, int(sr * fade_seconds))
    if fade_len <= 1:
        return audio

    shaped = audio.copy()
    fade_in = np.linspace(0.0, 1.0, fade_len, dtype=np.float32)
    fade_out = np.linspace(1.0, 0.0, fade_len, dtype=np.float32)
    shaped[:fade_len] *= fade_in[:, None]
    shaped[-fade_len:] *= fade_out[:, None]
    return shaped


def _chord_boundaries(beat_times: np.ndarray, duration_seconds: float, fallback_bpm: float) -> np.ndarray:
    if beat_times.size >= 4:
        starts = [0.0]
        starts.extend(float(beat_times[i]) for i in range(0, len(beat_times), 2) if beat_times[i] > 0.02)
        starts.append(duration_seconds)
        return np.unique(np.clip(np.asarray(starts, dtype=np.float32), 0.0, duration_seconds))

    beat = 60.0 / _sanitize_bpm(fallback_bpm)
    half_bar = beat * 2.0
    return np.arange(0.0, duration_seconds + half_bar, half_bar, dtype=np.float32).clip(max=duration_seconds)


def _regular_beat_grid(duration_seconds: float, beat_period: float) -> np.ndarray:
    return np.arange(0.0, max(duration_seconds, beat_period), beat_period, dtype=np.float32)


def _merge_repeated_chords(chords: list[ChiptuneChord]) -> list[ChiptuneChord]:
    merged: list[ChiptuneChord] = []
    for chord in chords:
        if merged and chord.root == merged[-1].root and chord.quality == merged[-1].quality:
            previous = merged[-1]
            merged[-1] = ChiptuneChord(
                previous.start,
                chord.end,
                previous.root,
                previous.quality,
                max(previous.confidence, chord.confidence),
            )
        else:
            merged.append(chord)
    return merged


def _merge_melody_notes(notes: list[ChiptuneNote], max_gap: float) -> list[ChiptuneNote]:
    merged: list[ChiptuneNote] = []
    for note in notes:
        if merged:
            prev = merged[-1]
            if note.pitch == prev.pitch and note.start <= prev.end + max_gap:
                merged[-1] = ChiptuneNote(
                    prev.start,
                    max(prev.end, note.end),
                    prev.pitch,
                    max(prev.velocity, note.velocity),
                )
                continue
        merged.append(note)
    return merged


def _merge_close_percussion_hits(
    hits: list[ChiptunePercussionHit],
    min_gap: float = 0.045,
) -> list[ChiptunePercussionHit]:
    priority = {"kick": 3, "snare": 2, "hat": 1}
    merged: list[ChiptunePercussionHit] = []
    for hit in sorted(hits, key=lambda item: item.start):
        if not merged or hit.start - merged[-1].start > min_gap:
            merged.append(hit)
            continue

        previous = merged[-1]
        if priority.get(hit.kind, 0) > priority.get(previous.kind, 0) or hit.velocity > previous.velocity * 1.2:
            merged[-1] = ChiptunePercussionHit(
                previous.start,
                hit.kind,
                max(previous.velocity, hit.velocity),
            )
        else:
            merged[-1] = ChiptunePercussionHit(
                previous.start,
                previous.kind,
                max(previous.velocity, hit.velocity),
            )
    return merged


def _limit_event_density(
    events: list[ChiptuneNote],
    *,
    max_events_per_second: float,
    duration_seconds: float,
) -> list[ChiptuneNote]:
    if duration_seconds <= 0.0:
        return events
    limit = max(1, int(math.ceil(duration_seconds * max_events_per_second)))
    if len(events) <= limit:
        return events
    kept = sorted(events, key=lambda item: (item.velocity, item.end - item.start), reverse=True)[:limit]
    return sorted(kept, key=lambda item: item.start)


def _limit_percussion_density(
    hits: list[ChiptunePercussionHit],
    duration_seconds: float,
    max_hits_per_second: float = 18.0,
) -> list[ChiptunePercussionHit]:
    if duration_seconds <= 0.0:
        return hits
    limit = max(1, int(math.ceil(duration_seconds * max_hits_per_second)))
    if len(hits) <= limit:
        return hits
    kept = sorted(hits, key=lambda item: item.velocity, reverse=True)[:limit]
    return sorted(kept, key=lambda item: item.start)


def _has_event_near(events: list[ChiptuneNote] | None, time_seconds: float, tolerance: float) -> bool:
    if not events:
        return False
    return any(abs(event.start - time_seconds) <= tolerance for event in events)


def _has_percussion_near(
    events: list[ChiptunePercussionHit] | None,
    time_seconds: float,
    tolerance: float,
) -> bool:
    if not events:
        return False
    return any(abs(event.start - time_seconds) <= tolerance for event in events)


def _is_near_any_beat(time_seconds: float, beat_times: np.ndarray, tolerance: float) -> bool:
    if beat_times.size == 0:
        return False
    return bool(np.min(np.abs(beat_times - time_seconds)) <= tolerance)


def _infer_chord_from_chroma(
    vector: np.ndarray,
    key: str,
    fallback_mode: str,
    *,
    previous: ChiptuneChord | None = None,
) -> tuple[int, str, float]:
    root_from_key = _root_pc_from_key(key)
    chroma = np.asarray(vector, dtype=np.float32).reshape(-1)
    if chroma.size < 12:
        chroma = np.pad(chroma, (0, 12 - chroma.size))
    chroma = np.nan_to_num(chroma[:12], nan=0.0, posinf=0.0, neginf=0.0)
    chroma = np.maximum(chroma, 0.0)

    total = float(np.sum(chroma))
    if total <= 1e-6:
        return root_from_key, fallback_mode, 0.0

    chroma = chroma / total
    scale = _scale_pitch_classes(key)
    candidates: list[tuple[float, float, int, str]] = []

    for root in range(12):
        for quality in _CHORD_QUALITIES:
            intervals = _chord_intervals(quality)
            tones = [(root + interval) % 12 for interval in intervals]
            root_strength = float(chroma[root])
            third_strength = float(chroma[(root + intervals[1]) % 12])
            fifth_strength = float(chroma[(root + 7) % 12])
            chord_energy = float(sum(float(chroma[tone]) for tone in tones))

            score = root_strength * 1.15 + third_strength * 0.92 + fifth_strength * 0.82
            score -= max(0.0, 1.0 - chord_energy) * 0.22
            if root in scale:
                score += 0.055
            if all(tone in scale for tone in tones):
                score += 0.035
            else:
                score -= 0.025
            if root == root_from_key:
                score += 0.025
            if quality == fallback_mode and root in scale:
                score += 0.012
            if previous is not None:
                if root == previous.root and quality == previous.quality:
                    score += 0.055
                elif root == previous.root:
                    score += 0.025
                elif root in {(previous.root + 5) % 12, (previous.root + 7) % 12}:
                    score += 0.012

            candidates.append((score, chord_energy, root, quality))

    candidates.sort(key=lambda item: item[0], reverse=True)
    best_score, best_energy, best_root, best_quality = candidates[0]
    next_score = candidates[1][0] if len(candidates) > 1 else best_score
    margin = max(0.0, best_score - next_score)
    confidence = float(np.clip(best_energy * 0.72 + margin * 1.8, 0.0, 1.0))
    return best_root, best_quality, confidence


def _chord_intervals(quality: str) -> tuple[int, int, int]:
    return (0, 3, 7) if quality == "minor" else (0, 4, 7)


def _chord_pitches(chord: ChiptuneChord, octave: int) -> list[int]:
    base = octave * 12 + chord.root
    return [_fold_pitch(base + interval, low=55, high=84) for interval in (*_chord_intervals(chord.quality), 12)]


def _chord_at(chords: list[ChiptuneChord], time_seconds: float) -> ChiptuneChord:
    for chord in chords:
        if chord.start <= time_seconds < chord.end:
            return chord
    return chords[-1] if chords else ChiptuneChord(0.0, time_seconds + 1.0, 0, "major")


def _snap_pitch_to_key(pitch: int, key: str) -> int:
    allowed = _scale_pitch_classes(key)
    if pitch % 12 in allowed:
        return pitch

    candidates = [pitch + offset for offset in (-2, -1, 1, 2) if (pitch + offset) % 12 in allowed]
    return min(candidates, key=lambda item: (abs(item - pitch), item)) if candidates else pitch


def _scale_pitch_classes(key: str) -> set[int]:
    root = _root_pc_from_key(key)
    scale = _MINOR_SCALE if _key_is_minor(key) else _MAJOR_SCALE
    return {(root + step) % 12 for step in scale}


def _key_is_minor(key: str) -> bool:
    normalized = (key or "").strip().lower()
    if "minor" in normalized:
        return True
    first_token = normalized.split()[0] if normalized.split() else ""
    return first_token.endswith("m") and not first_token.endswith("maj")


def _root_pc_from_key(key: str) -> int:
    root = (key or "C").split()[0]
    if root.endswith("m") and root not in _NOTE_TO_PC:
        root = root[:-1]
    if root:
        root = root[:1].upper() + root[1:]
    return _NOTE_TO_PC.get(root, 0)


def _is_near_grid(time_seconds: float, grid: float, tolerance: float = 0.035) -> bool:
    if grid <= 0.0:
        return False
    return abs(time_seconds - round(time_seconds / grid) * grid) <= tolerance


def _fold_pitch(pitch: int, *, low: int, high: int) -> int:
    while pitch < low:
        pitch += 12
    while pitch > high:
        pitch -= 12
    return max(low, min(high, pitch))


def _midi_to_hz(pitch: int) -> float:
    return float(440.0 * (2.0 ** ((pitch - 69) / 12.0)))


def _hz_to_midi(freq: float) -> float:
    return float(69.0 + 12.0 * math.log2(freq / 440.0))


def _sanitize_bpm(bpm: float) -> float:
    if not np.isfinite(bpm) or bpm <= 0:
        return 120.0
    return float(max(45.0, min(220.0, bpm)))


def _validate_render_options(sample_rate: int, bit_depth: int, chip_rate: int) -> None:
    if sample_rate < 8_000:
        raise ValueError("sample_rate must be at least 8000")
    if not 2 <= bit_depth <= 16:
        raise ValueError("bit_depth must be between 2 and 16")
    if chip_rate < 1_000:
        raise ValueError("chip_rate must be at least 1000")
    if chip_rate > sample_rate:
        raise ValueError("chip_rate cannot exceed sample_rate")
