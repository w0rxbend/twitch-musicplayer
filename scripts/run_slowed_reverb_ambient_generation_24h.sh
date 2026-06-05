#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/run_slowed_reverb_ambient_generation_24h.sh [OUT_DIR] [-- GENERATE_AMBIENT_BATCH_ARGS...]

Examples:
  scripts/run_slowed_reverb_ambient_generation_24h.sh
  scripts/run_slowed_reverb_ambient_generation_24h.sh output/sad_hours_24h
  scripts/run_slowed_reverb_ambient_generation_24h.sh output/sad_hours_24h -- --duration 240 --output wav,mp3
  RANDOM_SLOWED_REVERB_PRESETS=0 SLOWED_REVERB_PRESET="in the distance" scripts/run_slowed_reverb_ambient_generation_24h.sh output/distant_24h

Slowed + reverb presets:
  fading
  in_the_distance
  moving_apart
  my_last_day_on_earth
  nothing_matters
  roadtrips
  something_else
  the_hardest_part

Environment:
  RUN_HOURS                       Total supervised run length. Defaults to 24.
  TRACK_DURATION                  Final seconds per generated track. Defaults to 180.
  SEGMENT_DURATION                MusicGen segment seconds. Defaults to 30.
  CROSSFADE                       Crossfade seconds between generated chunks. Defaults to 2.
  RANDOM_PRESETS                  Choose a random lofi base preset for each track. Defaults to 0.
  PRESET                          Fixed lofi base preset when RANDOM_PRESETS=0. Defaults to slow_orbit.
  RANDOM_SLOWED_REVERB_PRESETS    Choose a random slowed + reverb preset for each track. Defaults to 1.
  SLOWED_REVERB_PRESET            Fixed slowed + reverb preset when RANDOM_SLOWED_REVERB_PRESETS=0.
                                  Defaults to fading.
  OUTPUT_FORMATS                  Comma-separated output formats. Defaults to mp3.
  RUNTIME                         transformers or openvino. Defaults to openvino.
  OPENVINO_DEVICE                 OpenVINO device name. Defaults to CPU.
  SONGGEN_BIN                     Path to songgen executable. Defaults to .venv/bin/songgen, then PATH.

The script starts songgen in the background with nohup and writes:
  OUT_DIR/generator.log
  OUT_DIR/generator.pid
  OUT_DIR/slowed_reverb_ambient_manifest.jsonl
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

out_dir="output/slowed_reverb_ambient_24h_$(date +%Y%m%d_%H%M%S)"
if [[ $# -gt 0 && "${1:-}" != "--" ]]; then
  out_dir=$1
  shift
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ -n "${SONGGEN_BIN:-}" ]]; then
  songgen=$SONGGEN_BIN
elif [[ -x ".venv/bin/songgen" ]]; then
  songgen=".venv/bin/songgen"
else
  songgen=$(command -v songgen || true)
fi

if [[ -z "$songgen" || ! -x "$songgen" ]]; then
  echo "Error: songgen executable not found. Set SONGGEN_BIN=/path/to/songgen." >&2
  exit 1
fi

run_hours="${RUN_HOURS:-24}"
track_duration="${TRACK_DURATION:-180}"
segment_duration="${SEGMENT_DURATION:-30}"
crossfade="${CROSSFADE:-2}"
random_presets="${RANDOM_PRESETS:-0}"
preset="${PRESET:-slow_orbit}"
random_slowed_reverb_presets="${RANDOM_SLOWED_REVERB_PRESETS:-1}"
slowed_reverb_preset="${SLOWED_REVERB_PRESET:-fading}"
output_formats="${OUTPUT_FORMATS:-mp3}"
runtime="${RUNTIME:-openvino}"
openvino_device="${OPENVINO_DEVICE:-CPU}"

preset_args=()
case "${random_presets,,}" in
  1|true|yes|on)
    preset_args=(--random-presets)
    ;;
  0|false|no|off)
    preset_args=(--preset "$preset")
    ;;
  *)
    echo "Error: RANDOM_PRESETS must be 1/0, true/false, yes/no, or on/off." >&2
    exit 2
    ;;
esac

slowed_reverb_args=()
case "${random_slowed_reverb_presets,,}" in
  1|true|yes|on)
    slowed_reverb_args=(--random-slowed-reverb-presets)
    ;;
  0|false|no|off)
    slowed_reverb_args=(--slowed-reverb-preset "$slowed_reverb_preset")
    ;;
  *)
    echo "Error: RANDOM_SLOWED_REVERB_PRESETS must be 1/0, true/false, yes/no, or on/off." >&2
    exit 2
    ;;
esac

mkdir -p "$out_dir"

pid_file="$out_dir/generator.pid"
log_file="$out_dir/generator.log"
manifest_file="$out_dir/slowed_reverb_ambient_manifest.jsonl"

if [[ -f "$pid_file" ]]; then
  old_pid=$(tr -d '[:space:]' < "$pid_file")
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "Error: generator already appears to be running with PID $old_pid." >&2
    echo "Log: $log_file" >&2
    exit 1
  fi
fi

nohup "$songgen" generate-ambient-batch \
  --run-hours "$run_hours" \
  --duration "$track_duration" \
  --segment-duration "$segment_duration" \
  --crossfade "$crossfade" \
  "${preset_args[@]}" \
  "${slowed_reverb_args[@]}" \
  --output "$output_formats" \
  --runtime "$runtime" \
  --openvino-device "$openvino_device" \
  --out-dir "$out_dir" \
  --manifest "$manifest_file" \
  "$@" > "$log_file" 2>&1 &

pid=$!
echo "$pid" > "$pid_file"

echo "Started slowed + reverb ambient generation PID $pid"
echo "Output: $out_dir"
echo "Log: $log_file"
echo "Manifest: $manifest_file"
echo "Watch: tail -f $log_file"
