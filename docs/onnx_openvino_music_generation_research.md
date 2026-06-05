# ONNX + OpenVINO Local Music Generation Research

Date: 2026-06-04

## Executive Recommendation

Do not replace the current procedural/MIDI lofi engine with a fully neural ONNX engine. The best architecture for this repository is hybrid:

```text
Prompt / preset / source audio
  -> MusicContext + StructurePlan
  -> deterministic MIDI arrangement
  -> optional ONNX/OpenVINO neural segment generator
  -> loop/segment selection + crossfade arrangement
  -> existing effects/mastering/export
```

Use ONNX/OpenVINO for short audio texture generation, optional prompt-to-loop generation, transcription, and stem separation. Keep the existing rule-based MIDI engine as the long-form backbone because it already creates controllable 3-10 minute structures, exports MIDI/WAV/MP3, and supports cover-style transformations.

The fastest useful prototype is MusicGen Small converted to OpenVINO IR, exposed as a new audio segment generator. The best commercial-direction research path is Stable Audio 3.0 Small/Medium, but it is too new to assume stable ONNX/OpenVINO support today.

## Current Repository Fit

The current project is already structured around symbolic generation:

| Area | Current code | Notes |
| --- | --- | --- |
| Composition context | `src/lofi_maker/core/music_context.py` | Key, BPM, chords, duration, density, swing, source melody. |
| Preset planning | `src/lofi_maker/core/lofi_arranger.py` | Builds `MusicContext` from presets and source-song analysis. |
| MIDI AI backend | `src/lofi_maker/ai/backend.py` | Current protocol returns `pretty_midi.PrettyMIDI`. |
| Rule generation | `src/lofi_maker/ai/rule_based.py` | Main reliable long-form generator. |
| Transformer MIDI | `src/lofi_maker/ai/transformer.py` | ABC/MIDI text model fallback, CPU feasible but not audio generation. |
| Rendering | `src/lofi_maker/render/soundfont.py` | MIDI to WAV. |
| Effects/mastering | `src/lofi_maker/render/effects.py`, `export.py` | Reusable for generated audio segments too. |
| Cover pipeline | `src/lofi_maker/cli.py`, `api.py` | Analyze source, extract melody, build cover context, render. |
| Stems | `src/lofi_maker/stems/separator.py` | Demucs PyTorch CPU path, currently slow but effective. |

The important constraint: `MusicAIBackend.generate_midi()` cannot represent MusicGen/Stable Audio/Riffusion because they output waveform audio. Add a sibling protocol rather than bending the MIDI backend:

```python
class AudioSegmentBackend(Protocol):
    name: str
    available: bool
    def generate_audio(self, plan: SegmentPlan) -> tuple[np.ndarray, int]: ...
```

## Model Landscape

| Model | Type | License | Local inference | ONNX/OpenVINO status | CPU viability | Fit |
| --- | --- | --- | --- | --- | --- | --- |
| MusicGen Small | autoregressive audio-token LM + EnCodec | CC-BY-NC 4.0 | Yes, HF Transformers/AudioCraft | Official OpenVINO notebook converts T5, LM, EnCodec to IR; community ONNX exports exist | Feasible but slow on CPU; best documented prototype | Text-to-lofi/ambient 10-30s loops. Not commercial without license review. |
| MusicGen Melody | MusicGen with melody conditioning | CC-BY-NC 4.0 | Yes | Same family; export harder than small text-only | Heavy CPU | Good research path for covers, but license and CPU cost are concerns. |
| Stable Audio Open 1.0 | latent diffusion text-to-audio | Stability AI Community License | Yes | Official OpenVINO notebook exists | CPU likely slow; OpenVINO helps but benchmark required | Ambient/SFX/production elements up to 47s. |
| Stable Audio 3.0 Small Music | latent diffusion, semantic-acoustic autoencoder | Stability AI Community License + Gemma terms | Yes, gated HF weights | No mature ONNX/OpenVINO path found yet | Claimed on-device; x86 CPU benchmark required | Best long-form candidate, up to 2 min. |
| Stable Audio 3.0 Medium | latent diffusion | Stability AI Community License + terms | Yes, gated HF weights | No mature ONNX/OpenVINO path found yet | Likely not CPU-first on typical x86 | Best open-weight long-form candidate, claimed >6 min. |
| Riffusion | Stable Diffusion on spectrogram images | repo/model licensing needs review | Yes | Official OpenVINO Riffusion notebook via Optimum Intel | CPU possible but diffusion is slow and quality is lower | Fun prototype, good for textures, not main lofi engine. |
| Magenta MusicVAE | symbolic MIDI VAE | Apache 2.0 code | Yes, TF/JS | ONNX export possible but legacy TF friction | Very CPU feasible | Good symbolic variation/loop generation, not waveform audio. |
| Basic Pitch | audio-to-MIDI transcription | Apache 2.0/GPL choice per project docs | Yes | Official package ships ONNX among model runtimes | Very CPU feasible | Replace/augment melody extraction, especially on Python 3.12+. |
| HT-Demucs ONNX | source separation | MIT in community ONNX exports matching Demucs | Yes | Community ONNX exports; OpenVINO conversion likely feasible | CPU slow but manageable offline | Stems for cover pipeline. |

## ONNX/OpenVINO Availability

### MusicGen

MusicGen is the best-supported ONNX/OpenVINO music-generation prototype today. Hugging Face describes it as a single-stage autoregressive Transformer that predicts discrete audio codes from text/audio conditioning and decodes them to waveform with EnCodec. Hugging Face also documents a hard 30-second generation limit from positional embeddings.

OpenVINO has an official MusicGen notebook that converts the three key components:

```text
T5 text encoder
MusicGen language model
EnCodec audio decoder
```

Recommended use here: convert and save OpenVINO IR files (`.xml`/`.bin`) during setup, then load compiled OpenVINO models in a cached FastAPI/CLI backend. Prefer native OpenVINO Runtime IR for production over ONNX Runtime when we control the conversion, because OpenVINO documents explicit IR conversion as the production path with lower first-inference latency and more optimization options.

Community ONNX MusicGen Small exports exist. One current model card reports:

```text
Base: facebook/musicgen-small
Precision: FP32
Sample rate: 32 kHz mono
Max length: ~30s
Total size: ~3.6 GB
Files: text_encoder.onnx, decoder_model.onnx, decoder_with_past_model.onnx, encodec_decode.onnx
```

Treat community ONNX exports as validation/prototype assets, not the default production dependency.

### Stable Audio

Stable Audio Open 1.0 generates up to 47 seconds of stereo 44.1 kHz audio and has an official OpenVINO notebook. It is more oriented toward samples, textures, SFX, and production elements than full songs.

Stable Audio 3.0 is the important new development as of May 2026. Stability AI states:

| Model | Claimed length | Notes |
| --- | --- | --- |
| Stable Audio 3.0 Small SFX | short SFX | on-device SFX |
| Stable Audio 3.0 Small Music | up to 2 min | full music composition on-device |
| Stable Audio 3.0 Medium | >6 min / up to 6:20 | higher structure and phrasing |
| Stable Audio 3.0 Large | >6 min | API/self-hosted enterprise |

However, no mature ONNX/OpenVINO integration path was found for Stable Audio 3.0 yet. It should be a Phase 2 research spike, not the first integration.

### Riffusion

Riffusion is supported by an official OpenVINO notebook and works by generating spectrogram images with a Stable Diffusion-derived model, then reconstructing audio from the spectrogram. It is useful for ambient texture experiments but is not recommended as the main generator because spectrogram inversion quality and musical structure are weaker than modern audio-native models.

### Basic Pitch

Basic Pitch is already the best fit for ONNX-based melody extraction. The official Spotify package ships TensorFlow, CoreML, TFLite, and ONNX serializations, and the runtime can choose ONNX. This is a clean upgrade target for `src/lofi_maker/analysis/melody_extractor.py`, especially since the current Basic Pitch dependency is gated off for Python 3.12+.

### Stem Separation

This repository already uses Demucs through PyTorch. For ONNX CPU inference, evaluate HT-Demucs ONNX exports. A current community export provides a single 316 MB FP32 ONNX file with input `(1, 2, 343980)` and output `(1, 4, 2, 343980)`, using overlap-add for longer audio. This aligns well with the current `StemBundle` abstraction.

## CPU Feasibility

Assumptions: Linux, modern x86 CPU, 16-64 GB RAM, no GPU required, optional Intel iGPU/NPU via OpenVINO.

| Workload | RAM estimate | CPU speed expectation | Recommendation |
| --- | --- | --- | --- |
| Basic Pitch ONNX transcription | <1 GB | Fast enough for CLI/API offline use | Use now for melody extraction. |
| MusicVAE / symbolic MIDI | <2 GB | Fast | Use for symbolic variations if needed. |
| Riffusion OpenVINO | 4-12 GB | Slow but usable for short clips | Prototype only. |
| MusicGen Small OpenVINO | 8-16 GB | Minutes for 10-30s on CPU is plausible; benchmark locally | Best first neural audio prototype. |
| Stable Audio Open 1.0 OpenVINO | 12-24 GB | Heavy diffusion workload | Ambient texture research, not default API path. |
| Stable Audio 3.0 Small | unknown x86 CPU; 2.27 GB weights for HF small music repo | Promising but unverified with ONNX/OpenVINO | Phase 2 spike. |
| HT-Demucs ONNX | 2-8 GB depending chunking | Offline, potentially several minutes per song | Use async/offline for covers. |

Do not promise realtime CPU generation until this repo has its own benchmark harness. Add a benchmark command that records:

```text
model_id
runtime: torch / onnxruntime / onnxruntime-openvino / openvino
device: CPU / GPU / AUTO
prompt
duration requested
wall time
peak RSS
output length
sample rate
```

## Long-Form Generation

Direct long-form generation is not reliable enough to be the platform backbone:

| Model | Direct 3 min | Direct 5 min | Direct 10 min | Notes |
| --- | --- | --- | --- | --- |
| MusicGen | No | No | No | HF documents 30s limit. Longer output requires continuation/windowing. |
| Stable Audio Open 1.0 | No | No | No | Up to 47s. |
| Stable Audio 3.0 Small | No | No | No | Claimed up to 2 min. |
| Stable Audio 3.0 Medium/Large | Yes for 3/5 min | Yes up to ~6:20 | No | New, not ONNX/OpenVINO-proven. |
| Riffusion | No | No | No | Short spectrogram clips. |
| Procedural MIDI engine | Yes | Yes | Yes | Already supports arbitrary duration. |

Recommended long-form architecture:

```text
StructurePlan
  intro: 8 bars
  A: 16 bars
  B: 16 bars
  breakdown: 8 bars
  A2: 16 bars
  outro: 8 bars

For each section:
  generate or render 8-30s loops/stems
  normalize loudness
  tempo-align/crossfade
  arrange repetitions and variations
  apply lofi effects/master bus
```

This keeps musical coherence in the planner and uses neural generation for color, not responsibility for the whole song.

## Cover Generation Recommendation

Use analysis/transformation, not neural "style transfer" as the first cover feature:

```text
source audio
  -> optional HT-Demucs ONNX stems
  -> Basic Pitch ONNX melody/chord evidence
  -> librosa tempo/key/chroma
  -> MusicContext
  -> lofi arrangement
  -> optional MusicGen Melody / Stable Audio segment coloring
  -> render/effects/export
```

Direct audio-to-audio cover generation remains risky for local CPU use: quality, copyright similarity, latency, and model licensing are all less predictable than MIDI-guided transformation.

## Proposed Code Architecture

Add new modules without breaking existing MIDI behavior:

```text
src/lofi_maker/
  ai/
    backend.py                 existing MIDI backend protocol
    segment_backend.py         new waveform backend protocol
    openvino_musicgen.py       MusicGen OpenVINO IR segment backend
    onnx_basic_pitch.py        melody extraction helper or backend
    onnx_demucs.py             optional stem separator implementation
  core/
    structure_plan.py          section/segment planner
    segment_arranger.py        crossfade/repetition/variation assembly
  render/
    audio_mix.py               loudness, crossfade, loop alignment helpers
```

New CLI/API options:

```text
songgen generate-preset sleepy_piano --neural-segments musicgen-openvino --duration 180
songgen generate-segment --prompt "warm lofi rhodes loop, tape hiss" --backend musicgen-openvino
songgen benchmark-ai --backend musicgen-openvino --duration 10
```

FastAPI should load neural models through the existing cache pattern, but generation requests should be async/offloaded to a worker for long CPU jobs.

## OpenVINO Runtime Strategy

Use two runtime paths:

1. Preferred production path: native OpenVINO IR
   - Convert with `openvino.convert_model()` or Optimum Intel.
   - Save `.xml`/`.bin`.
   - Load with `openvino.Core().compile_model(device_name="CPU" or "AUTO")`.

2. Compatibility path: ONNX Runtime OpenVINO Execution Provider
   - Use for third-party `.onnx` models.
   - Package dependency: `onnxruntime-openvino`.
   - Configure providers explicitly:

```python
providers = [
    ("OpenVINOExecutionProvider", {"device_type": "CPU"}),
    "CPUExecutionProvider",
]
```

Quantization:

- Start FP32 for correctness.
- Try INT8 with NNCF only after representative prompt/segment calibration exists.
- Quantize analysis and separation models before generative models; audio generators can lose quality from naive INT8.
- Keep a perceptual regression set: prompts, seeds, loudness, spectral centroid, clip rate, and human listen pass.

## Implementation Roadmap

### Implemented First Slice

The repository now includes a first MusicGen Small integration for lofi ambient generation:

```text
songgen generate-ambient --duration 12 --output mp3
songgen generate-ambient --prompt "slow dusty ambient lofi pads, felt piano, tape hiss" --duration 30 --output wav,mp3
songgen generate-ambient --runtime openvino --duration 12 --segment-duration 12
songgen generate-ambient --preset slow_orbit --slowed-reverb-preset "in the distance" --duration 180 --runtime openvino
songgen generate-ambient-batch --run-hours 24 --runtime openvino --duration 180 --segment-duration 30 --preset slow_orbit --random-slowed-reverb-presets
songgen generate-ambient-batch --run-hours 24 --runtime openvino --duration 180 --segment-duration 30 --random-presets
scripts/run_ambient_generation_24h.sh output/ambient_24h
scripts/run_slowed_reverb_ambient_generation_24h.sh output/sad_hours_24h
```

The default runtime uses Hugging Face Transformers on CPU. The OpenVINO runtime converts and caches `facebook/musicgen-small` IR files under `models/musicgen-small-openvino`, which is intentionally ignored by git because the generated model files are large.

For long unattended runs, use `generate-ambient-batch` or the `scripts/run_ambient_generation_24h.sh` launcher. The batch command keeps one backend process warm, catches per-track failures, writes every result to `ambient_batch_manifest.jsonl`, and stops when the time window or optional `--max-tracks` cap is reached. Add `--random-presets` to pick a different lofi preset for each track. Add `--slowed-reverb-preset NAME` or `--random-slowed-reverb-presets` to create slow, pitch-dropped, long-reverb ambient masters using the built-in effect presets: `fading`, `in_the_distance`, `moving_apart`, `my_last_day_on_earth`, `nothing_matters`, `roadtrips`, `something_else`, and `the_hardest_part`. The slowed-reverb launcher starts the same batch command with `nohup`, defaults to the `slow_orbit` base preset, randomizes the slowed-reverb effect preset, and writes `generator.log`, `generator.pid`, and the manifest into the output directory.

### Phase 1: Working ONNX/OpenVINO Prototype

Effort: 3-5 days.

- Add `AudioSegmentBackend`.
- Add `generate-segment` CLI command.
- Convert MusicGen Small to OpenVINO IR using the official notebook approach.
- Generate 5-15s clips, save WAV/MP3.
- Add benchmark command and store JSON results.
- Keep this non-commercial/research unless licensing is cleared.

Risks: slow CPU generation, model download size, MusicGen license.

### Phase 2: Production-Quality Local Generation

Effort: 1-3 weeks.

- Add `StructurePlan` and segment arranger.
- Let presets decide where neural segments are used: pads, intros, transitions, background texture.
- Add Stable Audio Open 1.0 OpenVINO spike for ambient textures.
- Add Stable Audio 3.0 Small/Medium export feasibility spike.
- Add async FastAPI job handling for long CPU tasks.

Risks: Stable Audio 3.0 export maturity, memory use, quality variance.

### Phase 3: Cover Generation Improvements

Effort: 1-2 weeks.

- Add Basic Pitch ONNX path to melody extraction.
- Add HT-Demucs ONNX stem separator implementation behind the existing `StemBundle`.
- Cache analysis/stems per source file hash.
- Keep the final cover arrangement MIDI-guided.

Risks: ONNX Demucs quality parity, CPU time, source material artifacts.

### Phase 4: Advanced Neural Generation

Effort: 3-6+ weeks.

- Evaluate MusicGen Melody/OpenVINO for melody-conditioned sections.
- Evaluate Stable Audio 3.0 inpainting/continuation for section edits.
- Add prompt/seed/version metadata to outputs for reproducibility.
- Add optional LoRA/fine-tune workflow only after licensing and dataset rights are settled.

Risks: high complexity, changing model APIs, licensing constraints.

## Direct Answers

### Q1: Can ONNX realistically be used as the primary local music generation engine?

Not for this project today. ONNX/OpenVINO should be a neural accelerator layer, not the primary composition engine. The strongest local models either generate short windows, are CPU-heavy, or are too new to rely on as the sole engine.

### Q2: Can ONNX generate high-quality ambient and lofi music on CPU only?

Yes for short clips and textures, with patience. MusicGen Small/OpenVINO is the best documented route. Stable Audio Open/3.0 are promising for ambience and full musical audio, but need local benchmarking and export validation.

### Q3: Can ONNX generate coherent 3-10 minute tracks directly?

No practical ONNX/OpenVINO path should be assumed. Stable Audio 3.0 Medium claims more than six minutes, but it is not yet a proven ONNX/OpenVINO CPU deployment path and still does not satisfy 10 minutes directly.

### Q4: Should the platform remain hybrid or move fully neural?

Remain hybrid:

```text
Procedural Composition
+ ONNX/OpenVINO Analysis
+ ONNX/OpenVINO Short Audio Generation
+ Existing Rendering/Effects
```

This is more maintainable, controllable, CPU-friendly, and compatible with MIDI/WAV/MP3 outputs.

### Q5: Exact model choices today

| Use case | Choice | Why |
| --- | --- | --- |
| Ambient generation | Stable Audio Open 1.0 OpenVINO for textures; Stable Audio 3.0 Small as spike | OpenVINO support exists for 1.0; 3.0 is better long-form but new. |
| Lofi generation | MusicGen Small OpenVINO for short loops; existing rule backend for full tracks | Best documented OpenVINO path; procedural engine provides duration/coherence. |
| Cover generation | Basic Pitch ONNX + procedural cover arranger; optionally MusicGen Melody research | Reliable source-to-MIDI transformation beats direct neural cover on CPU. |
| Audio analysis | librosa + Basic Pitch ONNX | Keeps Python 3.12+ viable and avoids TensorFlow dependency pain. |
| Stem separation | HT-Demucs ONNX, fallback to current PyTorch Demucs | Fits existing `StemBundle`; ONNX removes PyTorch inference dependency. |

## References

- OpenVINO model preparation and IR recommendation: https://docs.openvino.ai/2024/openvino-workflow/model-preparation.html
- ONNX Runtime OpenVINO Execution Provider: https://onnxruntime.ai/docs/execution-providers/OpenVINO-ExecutionProvider.html
- OpenVINO NNCF quantization flow: https://docs.openvino.ai/2023.3/basic_quantization_flow.html
- OpenVINO MusicGen notebook: https://docs.openvino.ai/2024/notebooks/music-generation-with-output.html
- OpenVINO Riffusion notebook: https://docs.openvino.ai/2024/notebooks/riffusion-text-to-music-with-output.html
- OpenVINO Stable Audio Open notebook: https://docs.openvino.ai/2024/notebooks/stable-audio-with-output.html
- Hugging Face MusicGen docs: https://huggingface.co/docs/transformers/en/model_doc/musicgen
- facebook/musicgen-small model card: https://huggingface.co/facebook/musicgen-small
- AudioCraft MusicGen API docs: https://facebookresearch.github.io/audiocraft/api_docs/audiocraft/models/musicgen.html
- Stable Audio Open 1.0 model card: https://huggingface.co/stabilityai/stable-audio-open-1.0
- Stable Audio 3.0 announcement: https://stability.ai/news-updates/meet-stable-audio-3-the-model-family-built-for-artistic-experimentation-with-open-weight-models
- Stable Audio 3 paper: https://arxiv.org/abs/2605.17991
- Stable Audio 3 Small Music model card: https://huggingface.co/stabilityai/stable-audio-3-small-music
- Riffusion hobby repository: https://github.com/riffusion/riffusion-hobby
- Spotify Basic Pitch repository: https://github.com/spotify/basic-pitch
- Magenta MusicVAE overview: https://magenta.tensorflow.org/music-vae
- Magenta.js MusicVAE docs: https://magenta.github.io/magenta-js/music/classes/_music_vae_model_.musicvae.html
- HT-Demucs ONNX community model card: https://huggingface.co/StemSplitio/htdemucs-onnx
