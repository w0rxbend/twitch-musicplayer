import numpy as np
import pytest

from lofi_maker.ai.musicgen import (
    audio_to_numpy,
    configure_openvino_musicgen_config,
    flatten_musicgen_cache,
    normalize_encodec_code_length,
    openvino_cache_metadata_matches,
    tokens_for_seconds,
    unflatten_musicgen_cache,
    validate_openvino_transformers_version,
)
from lofi_maker.ai.segment_backend import GeneratedAudio, SegmentRequest
from lofi_maker.core.neural_ambient import (
    build_ambient_prompt,
    generate_lofi_ambient_audio,
    get_slowed_reverb_preset,
    list_slowed_reverb_presets,
    slowed_reverb_source_duration,
)
from lofi_maker.presets.loader import load_preset
from lofi_maker.render.effects import apply_slowed_reverb_effects


class FakeAudioBackend:
    name = "fake"
    available = True

    def __init__(self, sr: int = 1000):
        self.sr = sr
        self.requests: list[SegmentRequest] = []

    def generate_audio(self, request: SegmentRequest) -> GeneratedAudio:
        self.requests.append(request)
        length = int(self.sr * request.duration_seconds)
        value = 0.1 + len(self.requests) * 0.1
        audio = np.full(length, value, dtype=np.float32)
        return GeneratedAudio(
            audio=audio,
            sample_rate=self.sr,
            model_id="fake",
            prompt=request.prompt,
        )


def test_tokens_for_seconds_uses_musicgen_frame_rate():
    assert tokens_for_seconds(8, frame_rate=50) == 403


def test_audio_to_numpy_transposes_channel_first_audio():
    audio = np.zeros((1, 2, 100), dtype=np.float32)
    result = audio_to_numpy(audio)
    assert result.shape == (100, 2)


def test_configure_openvino_musicgen_config_sets_supported_flags_only():
    class DecoderConfig:
        torchscript = True
        return_dict = False

    class Config:
        return_dict = False
        decoder = DecoderConfig()

    config = configure_openvino_musicgen_config(Config())

    assert config.return_dict is True
    assert config.decoder.torchscript is False
    assert config.decoder.return_dict is True


def test_validate_openvino_transformers_version_accepts_supported_range():
    validate_openvino_transformers_version("4.47.1")


def test_validate_openvino_transformers_version_rejects_unsupported_range():
    with pytest.raises(RuntimeError, match="transformers>=4.46,<4.48"):
        validate_openvino_transformers_version("5.10.1")


def test_openvino_cache_metadata_matches_expected_fields(tmp_path):
    path = tmp_path / "metadata.json"
    path.write_text('{"converter_version": "x", "model_id": "facebook/musicgen-small"}')

    assert openvino_cache_metadata_matches(
        path,
        {"converter_version": "x", "model_id": "facebook/musicgen-small"},
    )
    assert not openvino_cache_metadata_matches(path, {"converter_version": "y"})


def test_musicgen_cache_flattening_ignores_none_placeholders():
    layer = ("self_k", "self_v", None, "cross_k", "cross_v", None)
    assert flatten_musicgen_cache([layer]) == ("self_k", "self_v", "cross_k", "cross_v")


def test_musicgen_cache_unflattening_restores_encoder_decoder_layers():
    class FakeEncoderDecoderCache:
        def __init__(self, layers):
            self.layers = layers

    cache = unflatten_musicgen_cache(("self_k", "self_v", "cross_k", "cross_v"), FakeEncoderDecoderCache)

    assert cache.layers == [("self_k", "self_v", "cross_k", "cross_v")]


def test_normalize_encodec_code_length_pads_with_last_code():
    codes = np.array([[[[1, 2]]]], dtype=np.int64)

    padded = normalize_encodec_code_length(codes, 4)

    assert padded.tolist() == [[[[1, 2, 2, 2]]]]


def test_normalize_encodec_code_length_crops_extra_codes():
    codes = np.array([[[[1, 2, 3, 4]]]], dtype=np.int64)

    cropped = normalize_encodec_code_length(codes, 2)

    assert cropped.tolist() == [[[[1, 2]]]]


def test_build_ambient_prompt_uses_preset_context():
    preset = load_preset("ambient_lofi")
    prompt = build_ambient_prompt(preset, None)

    assert "slow ambient lofi instrumental" in prompt
    assert preset.mood in prompt
    assert "loopable" in prompt


def test_slowed_reverb_presets_include_named_effects():
    presets = {preset.name: preset for preset in list_slowed_reverb_presets()}

    assert set(presets) == {
        "fading",
        "in_the_distance",
        "moving_apart",
        "my_last_day_on_earth",
        "nothing_matters",
        "roadtrips",
        "something_else",
        "the_hardest_part",
    }
    assert get_slowed_reverb_preset("in the distance").name == "in_the_distance"
    assert get_slowed_reverb_preset("fading (slowed + reverb)").name == "fading"


def test_build_ambient_prompt_adds_slowed_reverb_context():
    preset = load_preset("slow_orbit")
    slowed = get_slowed_reverb_preset("nothing_matters")

    prompt = build_ambient_prompt(preset, None, slowed)

    assert "slowed down" in prompt
    assert "drenched in long reverb" in prompt
    assert slowed.prompt in prompt
    assert "no sampled vocals" in prompt


def test_slowed_reverb_source_duration_accounts_for_playback_rate():
    slowed = get_slowed_reverb_preset("the_hardest_part")

    assert slowed_reverb_source_duration(100.0, None) == 100.0
    assert slowed_reverb_source_duration(100.0, slowed) == pytest.approx(79.0)


def test_apply_slowed_reverb_effects_fits_target_duration():
    sr = 1000
    audio = np.linspace(-0.2, 0.2, sr, dtype=np.float32)
    slowed = get_slowed_reverb_preset("roadtrips")

    processed = apply_slowed_reverb_effects(
        audio,
        sr,
        playback_rate=slowed.playback_rate,
        reverb=slowed.reverb,
        wet_level=slowed.wet_level,
        lowpass_hz=slowed.lowpass_hz,
        fade_seconds=0.05,
        tail_seconds=0.1,
        distance=slowed.distance,
        gain=slowed.gain,
        target_duration_seconds=1.5,
    )

    assert processed.shape == (1500,)
    assert processed.dtype == np.float32
    assert np.isfinite(processed).all()


def test_generate_lofi_ambient_audio_splits_and_fits_duration():
    backend = FakeAudioBackend()

    result = generate_lofi_ambient_audio(
        backend=backend,
        prompt="soft ambient lofi",
        duration_seconds=25.0,
        seed=10,
        segment_seconds=10.0,
        crossfade_seconds=1.0,
    )

    assert result.audio.shape == (25_000,)
    assert result.sample_rate == 1000
    assert result.segment_count == 3
    assert [req.seed for req in backend.requests] == [10, 11, 12]
    assert all(req.prompt == "soft ambient lofi" for req in backend.requests)
