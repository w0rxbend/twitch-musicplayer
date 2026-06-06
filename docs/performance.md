# Performance Notes

## Rendering Target

The frontend targets 60 fps WebGL rendering.

## Current Optimizations

- Pixi is initialized with WebGL preference.
- GPU mode is set to high performance.
- Device pixel ratio is capped at `1.5`.
- Pixi ticker `maxFPS` is set to `60`.
- Default particle density is reduced.
- Bloom quality and blur are reduced.
- Chromatic split default is reduced.
- Core blob, fluid, wave, stars, and particle counts are lower than the initial implementation.
- Fluid and wave drawing reuse typed arrays instead of allocating arrays every frame.
- Backend audio streams feed the analyser directly, avoiding JavaScript MP3 buffering.

## Profiling

Use browser dev tools:

1. Open Performance tab.
2. Record 10-20 seconds during playback.
3. Check main-thread scripting time.
4. Check GPU/compositor load.
5. Compare frame time against the 16.7 ms budget for 60 fps.

## Expensive Features

These settings affect frame time most:

- Particle density.
- Bloom.
- Chromatic split.
- Scene complexity, especially space with more stars.
- Device pixel ratio.

## Tuning Advice

For lower-end devices:

- Set `density` below `0.8`.
- Set `bloom` below `0.7`.
- Set `aberration` to `0`.
- Keep the default DPR cap.

For high-end devices:

- Increase particle density cautiously.
- Prefer increasing intensity/bass before increasing bloom quality.
