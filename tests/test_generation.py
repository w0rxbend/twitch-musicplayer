import pytest
import pretty_midi
from lofi_maker.core.music_context import MusicContext
from lofi_maker.ai.rule_based import RuleBasedBackend
from lofi_maker.ai.disabled import DisabledBackend
from lofi_maker.core.lofi_arranger import from_preset
from lofi_maker.presets.loader import load_preset


def test_rule_based_returns_prettymidi():
    backend = RuleBasedBackend()
    ctx = MusicContext(bpm=80.0, duration_seconds=8.0, seed=42)
    midi = backend.generate_midi(ctx)
    assert isinstance(midi, pretty_midi.PrettyMIDI)


def test_rule_based_produces_notes():
    backend = RuleBasedBackend()
    ctx = MusicContext(bpm=80.0, duration_seconds=8.0, seed=42)
    midi = backend.generate_midi(ctx)
    total = sum(len(i.notes) for i in midi.instruments)
    assert total > 0


def test_rule_based_deterministic():
    backend = RuleBasedBackend()
    ctx = MusicContext(bpm=80.0, duration_seconds=8.0, seed=99)
    midi1 = backend.generate_midi(ctx)
    midi2 = backend.generate_midi(ctx)
    pitches1 = sorted(n.pitch for i in midi1.instruments for n in i.notes)
    pitches2 = sorted(n.pitch for i in midi2.instruments for n in i.notes)
    assert pitches1 == pitches2


def test_rule_based_minor_key():
    backend = RuleBasedBackend()
    ctx = MusicContext(key="D minor", bpm=75.0, duration_seconds=8.0, seed=1)
    midi = backend.generate_midi(ctx)
    assert any(len(i.notes) > 0 for i in midi.instruments)


def test_rule_based_major_key():
    backend = RuleBasedBackend()
    ctx = MusicContext(key="C major", bpm=85.0, duration_seconds=8.0, seed=7)
    midi = backend.generate_midi(ctx)
    assert any(len(i.notes) > 0 for i in midi.instruments)


def test_disabled_backend_raises():
    with pytest.raises(RuntimeError):
        DisabledBackend().generate_midi(MusicContext())


def test_disabled_backend_not_available():
    assert not DisabledBackend().available


def test_from_preset_respects_bpm_range():
    p = load_preset("rainy_window")
    for seed in range(5):
        ctx = from_preset(p, duration_seconds=10.0, seed=seed)
        assert p.bpm_range[0] <= ctx.bpm <= p.bpm_range[1]


def test_from_preset_sets_instrument_choices():
    p = load_preset("sleepy_piano")
    ctx = from_preset(p, duration_seconds=10.0, seed=1)

    assert ctx.chord_instrument == "felt_piano"
    assert ctx.melody_instrument == "felt_piano"


def test_instrument_count():
    backend = RuleBasedBackend()
    ctx = MusicContext(bpm=80.0, duration_seconds=8.0, seed=42)
    midi = backend.generate_midi(ctx)
    assert len(midi.instruments) == 4  # chords, bass, melody, drums


def test_rule_based_chords_overlap_bar_boundaries():
    backend = RuleBasedBackend()
    ctx = MusicContext(bpm=80.0, duration_seconds=16.0, seed=42)
    midi = backend.generate_midi(ctx)
    chords = next(i for i in midi.instruments if i.name == "chords")
    bar = (60.0 / ctx.bpm) * 4

    assert any(note.start < bar < note.end for note in chords.notes)


def test_rule_based_sparse_density_can_omit_drums():
    backend = RuleBasedBackend()
    ctx = MusicContext(bpm=70.0, duration_seconds=16.0, density=0.0, seed=42)
    midi = backend.generate_midi(ctx)
    drums = next(i for i in midi.instruments if i.name == "drums")

    assert len(drums.notes) == 0


def test_rule_based_uses_context_instruments():
    backend = RuleBasedBackend()
    ctx = MusicContext(
        bpm=70.0,
        duration_seconds=16.0,
        chord_instrument="felt_piano",
        melody_instrument="muted_trumpet",
        bass_instrument="upright_bass",
        seed=42,
    )
    midi = backend.generate_midi(ctx)

    assert next(i for i in midi.instruments if i.name == "chords").program == 0
    assert next(i for i in midi.instruments if i.name == "melody").program == 59
    assert next(i for i in midi.instruments if i.name == "bass").program == 32


def test_rule_based_notes_have_positive_duration():
    backend = RuleBasedBackend()
    ctx = MusicContext(bpm=80.0, duration_seconds=16.0, seed=123)
    midi = backend.generate_midi(ctx)

    for instrument in midi.instruments:
        for note in instrument.notes:
            assert note.end > note.start


def test_rule_based_chords_do_not_retrigger_overlapping_common_tones():
    backend = RuleBasedBackend()
    ctx = MusicContext(bpm=80.0, duration_seconds=32.0, seed=42)
    midi = backend.generate_midi(ctx)
    chords = next(i for i in midi.instruments if i.name == "chords")

    notes_by_pitch: dict[int, list[pretty_midi.Note]] = {}
    for note in chords.notes:
        notes_by_pitch.setdefault(note.pitch, []).append(note)

    for notes in notes_by_pitch.values():
        ordered = sorted(notes, key=lambda n: n.start)
        for left, right in zip(ordered, ordered[1:]):
            assert left.end <= right.start


def test_rule_based_preserves_source_melody_notes():
    backend = RuleBasedBackend()
    ctx = MusicContext(
        bpm=80.0,
        duration_seconds=8.0,
        melody_notes=[(0.5, 1.0, 64), (1.5, 2.0, 67)],
        seed=42,
    )
    midi = backend.generate_midi(ctx)
    melody = next(i for i in midi.instruments if i.name == "melody")

    assert [(n.start, n.end, n.pitch) for n in melody.notes] == [(0.5, 1.0, 64), (1.5, 2.0, 67)]
