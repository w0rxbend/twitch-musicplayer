#!/usr/bin/env bash
set -uo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/generate_random_tracks.sh [OUT_DIR] [-- GENERATE_RANDOM_ARGS...]

Examples:
  scripts/generate_random_tracks.sh output/random_tracks
  scripts/generate_random_tracks.sh output/random_tracks -- --duration 120 --output mp3
  TRACK_COUNT=20 scripts/generate_random_tracks.sh output/random_tracks -- --duration 60 --output midi,wav

Environment:
  TRACK_COUNT  Number of random tracks to generate. Defaults to 10.
  PRESETS_DIR  Directory containing preset .yaml files. Defaults to presets/lofi.
  RANDOM_SEED  Optional bash RANDOM seed for reproducible preset choices.
  SONGGEN_BIN  Path to songgen executable. Defaults to .venv/bin/songgen, then songgen from PATH.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

out_dir="output/random_tracks_$(date +%Y%m%d_%H%M%S)"
if [[ $# -gt 0 && "${1:-}" != "--" ]]; then
  out_dir=$1
  shift
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

track_count="${TRACK_COUNT:-10}"
if ! [[ "$track_count" =~ ^[0-9]+$ ]] || [[ "$track_count" -lt 1 ]]; then
  echo "Error: TRACK_COUNT must be a positive integer." >&2
  exit 2
fi

presets_dir="${PRESETS_DIR:-presets/lofi}"
if [[ ! -d "$presets_dir" ]]; then
  echo "Error: presets directory does not exist: $presets_dir" >&2
  exit 1
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

presets=()
while IFS= read -r -d '' preset_file; do
  presets+=("$(basename "$preset_file" .yaml)")
done < <(find "$presets_dir" -maxdepth 1 -type f -name '*.yaml' -print0 | sort -z)

if [[ ${#presets[@]} -eq 0 ]]; then
  echo "Error: no .yaml presets found in: $presets_dir" >&2
  exit 1
fi

if [[ -n "${RANDOM_SEED:-}" ]]; then
  RANDOM=$RANDOM_SEED
fi

mkdir -p "$out_dir"

ok=0
failed=0

for ((track=1; track<=track_count; track++)); do
  preset=${presets[$((RANDOM % ${#presets[@]}))]}
  echo
  echo "[$track/$track_count] Generating random track from preset: $preset"

  if "$songgen" generate-random "$preset" --count 1 --out-dir "$out_dir" "$@"; then
    ok=$((ok + 1))
  else
    failed=$((failed + 1))
    echo "Failed: random track $track ($preset)" >&2
  fi
done

echo
echo "Done. Generated: $ok/$track_count. Failed: $failed. Output: $out_dir"

if [[ $failed -gt 0 ]]; then
  exit 1
fi
