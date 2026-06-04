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

        chords_inst = pretty_midi.Instrument(program=_PROGRAMS["rhodes"], name="chords")
        bass_inst   = pretty_midi.Instrument(program=_PROGRAMS["muted_bass"], name="bass")
        melody_inst = pretty_midi.Instrument(program=_PROGRAMS["felt_piano"], name="melody")
        drums_inst  = pretty_midi.Instrument(program=0, is_drum=True, name="drums")

        scale = _MINOR_SCALE if context.is_minor else _MAJOR_SCALE

        for b in range(context.bars):
            t = b * bar
            root, intervals = chord_data[b % cycle]
            self._chord(chords_inst, root, intervals, t, bar)
            self._bass(bass_inst, root, t, bar, beat, context.swing)
            if random.random() < context.melody_density:
                self._melody_motif(melody_inst, root, scale, t, bar, beat)
            self._drums(drums_inst, t, beat, bar, context.swing, context.density)

        midi.instruments.extend([chords_inst, bass_inst, melody_inst, drums_inst])

        if context.seed is not None:
            random.setstate(rng_state)

        return midi

    # ------------------------------------------------------------------ #

    def _chord(self, inst, root, intervals, t0, bar_dur):
        notes = _voicing(root, intervals, base_octave=4)
        arpeggiate = random.random() < 0.25

        for i, pitch in enumerate(notes):
            onset = _jitter(t0 + (i * 0.035 if arpeggiate else 0.0), 0.010)
            dur = bar_dur * random.uniform(0.72, 0.92)
            inst.notes.append(pretty_midi.Note(
                velocity=_vel(54, 10),
                pitch=pitch,
                start=max(0.0, onset),
                end=onset + dur,
            ))

    def _bass(self, inst, root, t0, bar_dur, beat, swing):
        root_midi = root + 36  # 2 octaves below middle C
        fifth_midi = root + 43

        swing_push = (swing - 0.5) * beat if swing > 0.5 else 0.0

        # Root on beat 1
        inst.notes.append(pretty_midi.Note(
            velocity=_vel(68, 8),
            pitch=root_midi,
            start=_jitter(t0, 0.008),
            end=t0 + beat * 1.85,
        ))
        # Syncopated off-beat ghost note
        if random.random() < 0.55:
            t2 = t0 + beat * 2.0 + swing_push
            inst.notes.append(pretty_midi.Note(
                velocity=_vel(52, 8),
                pitch=fifth_midi if random.random() < 0.3 else root_midi,
                start=_jitter(t2, 0.010),
                end=t2 + beat * 0.85,
            ))

    def _melody_motif(self, inst, root, scale, t0, bar_dur, beat):
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

        n_notes = random.randint(1, 3)
        beats_available = [0, 1, 2, 3]
        chosen_beats = sorted(random.sample(beats_available, min(n_notes, 4)))

        prev = candidates[len(candidates) // 2]
        for beat_idx in chosen_beats:
            # Stepwise motion bias — feels more musical
            nearby = [c for c in candidates if abs(c - prev) <= 5] or candidates
            pitch = random.choice(nearby)
            onset = _jitter(t0 + beat_idx * beat, 0.018)
            dur = beat * random.uniform(0.45, 1.15)
            inst.notes.append(pretty_midi.Note(
                velocity=_vel(48, 14),
                pitch=pitch,
                start=max(0.0, onset),
                end=onset + dur,
            ))
            prev = pitch

    def _drums(self, inst, t0, beat, bar_dur, swing, density):
        KICK    = 36
        SNARE   = 38
        HIHAT_C = 42
        HIHAT_O = 46

        swing_push = (swing - 0.5) * beat if swing > 0.5 else 0.0

        # Kick: always beat 1, probabilistic beat 3
        inst.notes.append(pretty_midi.Note(_vel(72, 8), KICK, _jitter(t0, 0.006), t0 + 0.10))
        if random.random() < 0.45 * density:
            t3 = t0 + beat * 2.5
            inst.notes.append(pretty_midi.Note(_vel(62, 10), KICK, _jitter(t3, 0.010), t3 + 0.09))

        # Snare: beat 3
        t_snare = t0 + beat * 2
        inst.notes.append(pretty_midi.Note(_vel(64, 10), SNARE, _jitter(t_snare, 0.010), t_snare + 0.12))

        # Hi-hats: 8th notes with swing on the off-beats
        for eighth in range(8):
            t_hat = t0 + eighth * (beat / 2.0)
            if eighth % 2 == 1:
                t_hat += swing_push
            if random.random() > 0.12:  # occasional drop for groove
                hat = HIHAT_O if eighth % 4 == 2 and random.random() < 0.25 else HIHAT_C
                vel = _vel(42 if eighth % 2 == 0 else 32, 10)
                inst.notes.append(pretty_midi.Note(vel, hat, _jitter(t_hat, 0.006), t_hat + 0.05))
