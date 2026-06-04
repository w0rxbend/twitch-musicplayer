import pytest
from lofi_maker.presets.loader import list_presets, load_preset


def test_list_presets_non_empty():
    assert len(list_presets()) > 0


def test_all_known_presets_present():
    names = list_presets()
    for expected in [
        "rainy_window", "vinyl_jazz", "late_night_study", "dusty_808",
        "ambient_lofi", "sleepy_piano", "tape_warmth",
        "cassette_clouds", "chillhop_cafe", "deep_space_ambient",
        "dream_tape", "forest_pad", "frosted_glass", "golden_hour",
        "midnight_drizzle", "ocean_floor", "soft_focus", "urban_haze",
        "warm_rhodes_loop",
        "alone_at_piano", "distant_upright", "felt_piano_morning",
        "moonlit_keys", "piano_rain_room", "piano_sketchbook",
        "soft_classical_lofi", "tape_piano_nocturne",
    ]:
        assert expected in names, f"Missing preset: {expected}"


def test_load_preset_fields():
    p = load_preset("rainy_window")
    assert p.name == "rainy_window"
    assert 50 <= p.bpm_range[0] <= 120
    assert 50 <= p.bpm_range[1] <= 120
    assert 0.0 <= p.swing <= 1.0
    assert 0.0 <= p.drum_density <= 1.0


def test_all_presets_load_without_error():
    for name in list_presets():
        p = load_preset(name)
        assert p.name == name


def test_missing_preset_raises():
    with pytest.raises(FileNotFoundError):
        load_preset("no_such_preset_xyz")


def test_effects_config_loaded():
    p = load_preset("ambient_lofi")
    assert 0.0 <= p.effects.reverb <= 1.0
    assert p.effects.lowpass_hz > 0
