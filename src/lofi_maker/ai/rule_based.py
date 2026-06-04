from __future__ import annotations
import random
import pretty_midi
from ..core.music_context import MusicContext


_NOTE_SEMITONES: dict[str, int] = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4,
    "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8,
    "A": 9, "A#": 10, "Bb": 10, "B": 11,
}

_CHORD_INTERVALS: dict[str, list[int]] = {
    "maj7":  [0, 4, 7, 11],
    "maj9":  [0, 4, 7, 11, 14],
    "m7":    [0, 3, 7, 10],
    "m9":    [0, 3, 7, 10, 14],
    "m11":   [0, 3, 7, 10, 14, 17],
    "7":     [0, 4, 7, 10],
    "9":     [0, 4, 7, 10, 14],
    "13":    [0, 4, 7, 10, 14, 21],
    "m6":    [0, 3, 7, 9],
    "maj6":  [0, 4, 7, 9],
    "hdim7": [0, 3, 6, 10],
    "sus2":  [0, 2, 7],
    "sus4":  [0, 5, 7],
}

# GM program numbers for common lofi timbres
_PROGRAMS: dict[str, int] = {
    "felt_piano":    0,    # Acoustic Grand — treated as muffled in post
    "rhodes":        4,    # Electric Piano 1
    "muted_bass":    33,   # Electric Bass (finger)
    "upright_bass":  32,   # Acoustic Bass
    "synth_bass":    38,   # Synth Bass 1
    "pad":           89,   # Pad 2 (warm)
    "muted_trumpet": 59,   # Muted Trumpet
}

_MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]   # natural minor
_MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]


def _parse_chord(symbol: str) -> tuple[int, list[int]]:
    for note in sorted(_NOTE_SEMITONES, key=len, reverse=True):
        if symbol.startswith(note):
            root = _NOTE_SEMITONES[note]
            quality = symbol[len(note):]
            intervals = _CHORD_INTERVALS.get(quality, _CHORD_INTERVALS["m7"])
            return root, intervals
    return 0, _CHORD_INTERVALS["m7"]


def _voicing(root: int, intervals: list[int], base_octave: int = 4) -> list[int]:
    base = root + base_octave * 12
    notes = [base + i for i in intervals]
    # Keep within a playable range
    while notes and max(notes) > 86:
        notes = [n - 12 for n in notes]
    # Open up the voicing: push the 5th up an octave for that spread lofi feel
    if len(notes) >= 3:
        candidate = notes[2] + 12
        if candidate <= 90:
            notes[2] = candidate
    return [n for n in notes if 21 <= n <= 108]


def _jitter(t: float, sigma: float = 0.012) -> float:
    return t + random.gauss(0, sigma)


def _vel(base: int, spread: int = 12) -> int:
    return max(1, min(127, base + random.randint(-spread, spread)))


def _nearest_pitch(pitch: int, target: int) -> int:
    candidates = [pitch - 12, pitch, pitch + 12]
    return min(candidates, key=lambda candidate: abs(candidate - target))


def _voice_lead(notes: list[int], previous: list[int] | None) -> list[int]:
    if not previous:
        return notes

    led: list[int] = []
    for i, pitch in enumerate(notes):
        target = previous[min(i, len(previous) - 1)]
        candidates = [
            pitch + 12 * shift
            for shift in range(-2, 3)
            if 40 <= pitch + 12 * shift <= 90
        ]
        led.append(min(candidates or [pitch], key=lambda candidate: abs(candidate - target)))
    return sorted(led)


class RuleBasedBackend:
    @property
    def name(self) -> str:
        return "rule_based"

    @property
    def available(self) -> bool:
        return True

    def generate_midi(self, context: MusicContext) -> pretty_midi.PrettyMIDI:
        rng_state = random.getstate()
        if context.seed is not None:
            random.seed(context.seed)

        midi = pretty_midi.PrettyMIDI(initial_tempo=context.bpm)
        beat = 60.0 / context.bpm
        bar = beat * 4

        chord_data = [_parse_chord(c) for c in context.chords]
        cycle = len(chord_data)

        chords_inst = pretty_midi.Instrument(
            program=_PROGRAMS.get(context.chord_instrument, _PROGRAMS["rhodes"]),
            name="chords",
        )
        bass_inst = pretty_midi.Instrument(
            program=_PROGRAMS.get(context.bass_instrument, _PROGRAMS["muted_bass"]),
            name="bass",
        )
        melody_inst = pretty_midi.Instrument(
            program=_PROGRAMS.get(context.melody_instrument, _PROGRAMS["felt_piano"]),
            name="melody",
        )
        drums_inst  = pretty_midi.Instrument(program=0, is_drum=True, name="drums")

        scale = _MINOR_SCALE if context.is_minor else _MAJOR_SCALE

        previous_chord_notes: list[int] | None = None
        previous_melody_pitch: int | None = None
        harmonic_span = 2
        has_source_melody = bool(context.melody_notes)

        for b in range(context.bars):
            t = b * bar
            chord_index = (b // harmonic_span) % cycle
            next_chord_index = ((b + 1) // harmonic_span) % cycle
            root, intervals = chord_data[chord_index]
            next_root, _ = chord_data[next_chord_index]

            if b % harmonic_span == 0:
                previous_chord_notes = _voice_lead(
                    _voicing(root, intervals, base_octave=4),
                    previous_chord_notes,
                )
            self._chord(chords_inst, previous_chord_notes or _voicing(root, intervals, base_octave=4), t, bar, beat)

            add_pickup = next_chord_index != chord_index
            self._bass(
                bass_inst,
                root,
                next_root,
                t,
                bar,
                beat,
                context.swing,
                context.density,
                add_pickup,
            )
            if not has_source_melody and random.random() < context.melody_density:
                previous_melody_pitch = self._melody_motif(
                    melody_inst,
                    root,
                    scale,
                    t,
                    bar,
                    beat,
                    previous_melody_pitch,
                )
            self._drums(drums_inst, t, beat, bar, context.swing, context.density)

        if has_source_melody:
            self._source_melody(melody_inst, context.melody_notes or [], context.duration_seconds)

        self._merge_near_repeated_notes(melody_inst, max_gap=beat * 0.05)
        midi.instruments.extend([chords_inst, bass_inst, melody_inst, drums_inst])

        if context.seed is not None:
            random.setstate(rng_state)

        return midi

    # ------------------------------------------------------------------ #

    def _chord(self, inst, notes, t0, bar_dur, beat):
        arpeggiate = random.random() < 0.35
        dur = bar_dur * random.uniform(0.92, 1.02)

        for i, pitch in enumerate(notes):
            onset = _jitter(t0 + (i * 0.030 if arpeggiate else 0.0), 0.006)
            inst.notes.append(pretty_midi.Note(
                velocity=_vel(46, 7),
                pitch=pitch,
                start=max(0.0, onset),
                end=max(0.0, onset) + dur,
            ))

        # A quiet mid-bar re-articulation keeps piano/Rhodes samples from decaying into silence.
        if len(notes) >= 3:
            onset = _jitter(t0 + beat * random.choice([1.75, 2.0, 2.25]), 0.010)
            color_notes = notes[-2:] if len(notes) >= 4 else notes[-1:]
            color_dur = min(t0 + bar_dur + beat * 0.05, onset + beat * random.uniform(1.25, 1.9))
            for pitch in color_notes:
                inst.notes.append(pretty_midi.Note(
                    velocity=_vel(27, 4),
                    pitch=pitch,
                    start=max(0.0, onset),
                    end=color_dur,
                ))

        # A soft upper color tone late in the bar helps bridge chord changes.
        if len(notes) >= 4 and random.random() < 0.45:
            onset = _jitter(t0 + beat * random.choice([3.0, 3.25]), 0.010)
            pitch = notes[-1]
            inst.notes.append(pretty_midi.Note(
                velocity=_vel(25, 4),
                pitch=pitch,
                start=max(0.0, onset),
                end=min(t0 + bar_dur + beat * 0.08, max(0.0, onset) + beat * random.uniform(0.6, 1.0)),
            ))

    def _bass(self, inst, root, next_root, t0, bar_dur, beat, swing, density, add_pickup):
        if density <= 0.03 or random.random() > 0.35 + density * 0.65:
            return

        root_midi = root + 36  # 2 octaves below middle C
        fifth_midi = root + 43
        next_root_midi = _nearest_pitch(next_root + 36, root_midi)

        swing_push = (swing - 0.5) * beat if swing > 0.5 else 0.0

        # Root on beat 1
        inst.notes.append(pretty_midi.Note(
            velocity=_vel(58, 6),
            pitch=root_midi,
            start=_jitter(t0, 0.008),
            end=t0 + beat * random.uniform(2.0, 2.35),
        ))
        # Syncopated off-beat ghost note
        if random.random() < 0.35 + density * 0.35:
            t2 = t0 + beat * 2.0 + swing_push
            inst.notes.append(pretty_midi.Note(
                velocity=_vel(42, 6),
                pitch=fifth_midi if random.random() < 0.3 else root_midi,
                start=_jitter(t2, 0.010),
                end=t2 + beat * 0.95,
            ))

        if add_pickup and random.random() < 0.45 + density * 0.30:
            pickup = t0 + beat * random.choice([3.0, 3.5]) + swing_push * 0.5
            inst.notes.append(pretty_midi.Note(
                velocity=_vel(38, 5),
                pitch=next_root_midi,
                start=_jitter(pickup, 0.010),
                end=t0 + bar_dur + beat * 0.10,
            ))

    def _melody_motif(self, inst, root, scale, t0, bar_dur, beat, previous_pitch):
        root_idx = root % 12
        # Build scale notes in the singable octave (C4–C6)
        candidates = []
        for octave in [4, 5]:
            for step in scale:
                pitch = root_idx + step + octave * 12
                if 57 <= pitch <= 84:
                    candidates.append(pitch)

        if not candidates:
            return

        n_notes = random.randint(2, 4)
        start_step = random.choice([0, 1, 2])
        spacing = random.choice([0.5, 1.0])
        chosen_offsets = [start_step * 0.5 + i * spacing for i in range(n_notes)]
        chosen_offsets = [offset for offset in chosen_offsets if offset < 3.75]

        prev = previous_pitch if previous_pitch in candidates else candidates[len(candidates) // 2]
        for offset in chosen_offsets:
            # Stepwise motion bias — feels more musical
            nearby = [c for c in candidates if abs(c - prev) <= 4] or candidates
            pitch = random.choice(nearby)
            onset = _jitter(t0 + offset * beat, 0.014)
            dur = beat * random.uniform(0.72, 1.35)
            inst.notes.append(pretty_midi.Note(
                velocity=_vel(42, 10),
                pitch=pitch,
                start=max(0.0, onset),
                end=onset + dur,
            ))
            prev = pitch
        return prev

    def _source_melody(self, inst, notes, duration_seconds):
        for start, end, pitch in notes:
            start = max(0.0, float(start))
            if start >= duration_seconds:
                continue

            end = min(float(end), duration_seconds)
            if end <= start:
                end = start + 0.12

            pitch = int(pitch)
            while pitch < 48:
                pitch += 12
            while pitch > 88:
                pitch -= 12

            inst.notes.append(pretty_midi.Note(
                velocity=_vel(52, 9),
                pitch=max(21, min(108, pitch)),
                start=start,
                end=max(start + 0.08, end),
            ))

    def _drums(self, inst, t0, beat, bar_dur, swing, density):
        if density <= 0.03:
            return

        KICK    = 36
        SNARE   = 38
        HIHAT_C = 42
        HIHAT_O = 46

        swing_push = (swing - 0.5) * beat if swing > 0.5 else 0.0

        # Kick: strong at higher density, optional for sparse/piano presets
        if random.random() < min(0.25 + density * 0.85, 0.95):
            inst.notes.append(pretty_midi.Note(_vel(62, 6), KICK, _jitter(t0, 0.006), t0 + 0.12))
        if random.random() < 0.45 * density:
            t3 = t0 + beat * 2.5
            inst.notes.append(pretty_midi.Note(_vel(52, 8), KICK, _jitter(t3, 0.010), t3 + 0.11))

        # Snare: beat 3
        if random.random() < min(0.20 + density * 0.80, 0.95):
            t_snare = t0 + beat * 2
            inst.notes.append(pretty_midi.Note(_vel(54, 7), SNARE, _jitter(t_snare, 0.010), t_snare + 0.16))

        # Hi-hats: 8th notes with swing on the off-beats
        for eighth in range(8):
            t_hat = t0 + eighth * (beat / 2.0)
            if eighth % 2 == 1:
                t_hat += swing_push
            if random.random() < density * 0.90:
                hat = HIHAT_O if eighth % 4 == 2 and random.random() < 0.18 else HIHAT_C
                vel = _vel(30 if eighth % 2 == 0 else 24, 6)
                inst.notes.append(pretty_midi.Note(vel, hat, _jitter(t_hat, 0.006), t_hat + 0.075))

    def _merge_near_repeated_notes(self, inst, max_gap):
        if not inst.notes:
            return

        merged: list[pretty_midi.Note] = []
        for note in sorted(inst.notes, key=lambda n: (n.pitch, n.start, n.end)):
            if (
                merged
                and merged[-1].pitch == note.pitch
                and note.start <= merged[-1].end + max_gap
            ):
                merged[-1].end = max(merged[-1].end, note.end)
                merged[-1].velocity = max(merged[-1].velocity, note.velocity)
            else:
                merged.append(note)

        inst.notes = sorted(merged, key=lambda n: (n.start, n.pitch, n.end))
