#!/usr/bin/env bash
set -uo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/generate_all_presets.sh [OUT_DIR] [-- GENERATE_PRESET_ARGS...]

Examples:
  scripts/generate_all_presets.sh output/all_presets
  scripts/generate_all_presets.sh output/all_presets -- --duration 120 --output mp3
  scripts/generate_all_presets.sh output/all_presets -- --duration 60 --output midi,wav --seed 42

Environment:
  PRESETS_DIR  Directory containing preset .yaml files. Defaults to presets/lofi.
  SONGGEN_BIN  Path to songgen executable. Defaults to .venv/bin/songgen, then songgen from PATH.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

out_dir="output/all_presets"
if [[ $# -gt 0 && "${1:-}" != "--" ]]; then
  out_dir=$1
  shift
fi

if [[ "${1:-}" == "--" ]]; then
  shift
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

mkdir -p "$out_dir"

total=0
ok=0
failed=0

while IFS= read -r -d '' preset_file; do
  total=$((total + 1))
  preset_name=$(basename "$preset_file" .yaml)

  echo
  echo "[$total] Generating preset: $preset_name"

  if "$songgen" generate-preset "$preset_name" --out-dir "$out_dir" "$@"; then
    ok=$((ok + 1))
  else
    failed=$((failed + 1))
    echo "Failed: $preset_name" >&2
  fi
done < <(find "$presets_dir" -maxdepth 1 -type f -name '*.yaml' -print0 | sort -z)

echo
echo "Done. Generated: $ok/$total. Failed: $failed. Output: $out_dir"

if [[ $total -eq 0 ]]; then
  echo "No .yaml presets found in: $presets_dir" >&2
  exit 1
fi

if [[ $failed -gt 0 ]]; then
  exit 1
fi
