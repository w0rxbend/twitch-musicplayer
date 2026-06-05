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
class ChiptuneCoverResult:
    audio: np.ndarray
    sample_rate: int
    bpm: float
    key: str
    source_duration_seconds: float
    rendered_duration_seconds: float
    melody_note_count: int
    chord_count: int
    beat_count: int
    chord_events: list[ChiptuneChord]
    melody_events: list[ChiptuneNote]
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
    bpm = _sanitize_bpm(context.source_bpm or context.bpm)
    key = context.key

    harmonic, percussive = _split_harmonic_percussive(y)
    beat_times = _detect_beat_times(percussive, analysis_sr, bpm, target_duration)
    chord_events = _extract_chord_events(harmonic, analysis_sr, target_duration, beat_times, key, bpm)

    source_notes = list(melody_notes) if melody_notes is not None else extract_melody(melody_source)
    melody_events = _fit_melody_notes(source_notes or [], bpm, target_duration, key)
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
        chord_count=len(chord_events),
        beat_count=len(beat_times),
        chord_events=chord_events,
        melody_events=melody_events,
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
        _render_bass(mix, chord_events, beat_times, beat, duration_seconds, sample_rate, bass_volume)

    for index, note in enumerate(melody_events):
        pan = -0.28 if index % 2 == 0 else 0.24
        duty = 0.50 if index % 3 else 0.25
        _add_note(
            mix,
            sample_rate,
            start=note.start,
            end=note.end,
            pitch=note.pitch,
            volume=lead_volume * note.velocity,
            waveform="square",
            pan=pan,
            duty=duty,
            attack=0.003,
            release=0.025,
        )

    _render_drums(mix, beat_times, beat, duration_seconds, sample_rate, drum_volume, rng)
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
    mode = "minor" if "minor" in key.lower() else "major"
    bars = _bar_boundaries(beat_times, duration_seconds, fallback_bpm=bpm)

    try:
        chroma = librosa.feature.chroma_cqt(y=harmonic, sr=sr, hop_length=512)
        chroma = scipy.ndimage.median_filter(chroma, size=(1, 5))
        times = librosa.times_like(chroma, sr=sr, hop_length=512)
    except Exception:
        chroma = np.zeros((12, 0), dtype=np.float32)
        times = np.zeros(0, dtype=np.float32)

    events: list[ChiptuneChord] = []
    for start, end in zip(bars[:-1], bars[1:]):
        if end <= start:
            continue

        if chroma.size:
            mask = (times >= start) & (times < end)
            vector = np.median(chroma[:, mask], axis=1) if np.any(mask) else np.zeros(12)
        else:
            vector = np.zeros(12)

        if float(np.sum(vector)) <= 1e-6:
            root = root_from_key
            quality = mode
            confidence = 0.0
        else:
            root = int(np.argmax(vector))
            quality = _chord_quality_from_chroma(vector, root, mode)
            confidence = float(vector[root] / max(np.sum(vector), 1e-6))

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
    grid = beat / 4.0
    fitted_by_slot: dict[int, ChiptuneNote] = {}

    for raw_start, raw_end, raw_pitch in notes:
        start = max(0.0, float(raw_start))
        end = max(start + 0.05, float(raw_end))
        if start >= duration_seconds:
            continue

        q_start = round(start / grid) * grid
        q_end = round(end / grid) * grid
        q_start = max(0.0, min(duration_seconds, q_start))
        q_end = min(duration_seconds, max(q_start + grid * 0.8, q_end))
        if q_end <= q_start:
            continue

        pitch = _fold_pitch(int(round(raw_pitch)), low=60, high=84)
        pitch = _snap_pitch_to_key(pitch, key)
        note = ChiptuneNote(q_start, q_end, pitch, velocity=1.0)
        slot = int(round(q_start / grid))
        previous = fitted_by_slot.get(slot)
        if previous is None or (note.end - note.start) > (previous.end - previous.start):
            fitted_by_slot[slot] = note

    return _merge_melody_notes(sorted(fitted_by_slot.values(), key=lambda item: (item.start, item.pitch)), grid)


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
    step = beat / 2.0
    for chord in chords:
        pitches = _chord_pitches(chord, octave=4)
        t = chord.start
        index = 0
        while t < chord.end:
            pitch = pitches[index % len(pitches)]
            _add_note(
                mix,
                sr,
                start=t,
                end=min(chord.end, t + step * 0.85),
                pitch=pitch,
                volume=volume * 0.62,
                waveform="pulse",
                pan=0.34,
                duty=0.25,
                attack=0.002,
                release=0.018,
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
) -> None:
    beats = beat_times if beat_times.size >= 4 else _regular_beat_grid(duration_seconds, beat)
    for index, start in enumerate(beats):
        if start >= duration_seconds:
            continue
        if index % 4 not in (0, 2, 3):
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
            volume=volume,
            waveform="triangle",
            pan=-0.12,
            attack=0.003,
            release=0.035,
        )


def _render_drums(
    mix: np.ndarray,
    beat_times: np.ndarray,
    beat: float,
    duration_seconds: float,
    sr: int,
    volume: float,
    rng: np.random.Generator,
) -> None:
    beats = beat_times if beat_times.size >= 4 else _regular_beat_grid(duration_seconds, beat)
    for index, start in enumerate(beats):
        if start >= duration_seconds:
            continue
        beat_in_bar = index % 4
        if beat_in_bar in (0, 2):
            _add_kick(mix, sr, float(start), volume * 0.92)
        if beat_in_bar in (1, 3):
            _add_noise_hit(mix, sr, float(start), 0.12, volume * 0.82, rng, mode="snare", pan=0.12)

        hat_start = float(start) + beat * 0.5
        if hat_start < duration_seconds:
            _add_noise_hit(mix, sr, hat_start, 0.035, volume * 0.32, rng, mode="hat", pan=-0.22)


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


def _bar_boundaries(beat_times: np.ndarray, duration_seconds: float, fallback_bpm: float) -> np.ndarray:
    if beat_times.size >= 4:
        starts = [0.0]
        starts.extend(float(beat_times[i]) for i in range(0, len(beat_times), 4) if beat_times[i] > 0.02)
        starts.append(duration_seconds)
        return np.unique(np.clip(np.asarray(starts, dtype=np.float32), 0.0, duration_seconds))

    beat = 60.0 / _sanitize_bpm(fallback_bpm)
    bar = beat * 4.0
    return np.arange(0.0, duration_seconds + bar, bar, dtype=np.float32).clip(max=duration_seconds)


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


def _chord_quality_from_chroma(vector: np.ndarray, root: int, fallback_mode: str) -> str:
    major = float(vector[(root + 4) % 12] + 0.6 * vector[(root + 11) % 12])
    minor = float(vector[(root + 3) % 12] + 0.6 * vector[(root + 10) % 12])
    if max(major, minor) <= 1e-6:
        return fallback_mode
    return "minor" if minor > major * 1.08 else "major"


def _chord_pitches(chord: ChiptuneChord, octave: int) -> list[int]:
    third = 3 if chord.quality == "minor" else 4
    base = octave * 12 + chord.root
    return [_fold_pitch(base + interval, low=55, high=84) for interval in (0, third, 7, 12)]


def _chord_at(chords: list[ChiptuneChord], time_seconds: float) -> ChiptuneChord:
    for chord in chords:
        if chord.start <= time_seconds < chord.end:
            return chord
    return chords[-1] if chords else ChiptuneChord(0.0, time_seconds + 1.0, 0, "major")


def _snap_pitch_to_key(pitch: int, key: str) -> int:
    root = _root_pc_from_key(key)
    scale = _MINOR_SCALE if "minor" in key.lower() else _MAJOR_SCALE
    allowed = {(root + step) % 12 for step in scale}
    if pitch % 12 in allowed:
        return pitch

    candidates = [pitch + offset for offset in (-2, -1, 1, 2) if (pitch + offset) % 12 in allowed]
    return min(candidates, key=lambda item: (abs(item - pitch), item)) if candidates else pitch


def _root_pc_from_key(key: str) -> int:
    root = (key or "C").split()[0]
    return _NOTE_TO_PC.get(root, 0)


def _fold_pitch(pitch: int, *, low: int, high: int) -> int:
    while pitch < low:
        pitch += 12
    while pitch > high:
        pitch -= 12
    return max(low, min(high, pitch))


def _midi_to_hz(pitch: int) -> float:
    return float(440.0 * (2.0 ** ((pitch - 69) / 12.0)))


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
