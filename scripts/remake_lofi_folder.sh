#!/usr/bin/env bash
set -uo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/remake_lofi_folder.sh INPUT_DIR [OUT_DIR] [-- REMAKE_LOFI_ARGS...]

Examples:
  scripts/remake_lofi_folder.sh ncs_music output/ncs_lofi
  scripts/remake_lofi_folder.sh ncs_music output/ncs_lofi -- --duration 120 --output mp3
  scripts/remake_lofi_folder.sh ncs_music output/ncs_lofi -- --skip-stems

Environment:
  SONGGEN_BIN  Path to songgen executable. Defaults to .venv/bin/songgen, then songgen from PATH.

Optional full cover pipeline deps:
  pipx run uv sync --extra stems --extra melody
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 2
fi

input_dir=$1
shift

out_dir="output/remake_lofi_batch_$(date +%Y%m%d_%H%M%S)"
if [[ $# -gt 0 && "${1:-}" != "--" ]]; then
  out_dir=$1
  shift
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ ! -d "$input_dir" ]]; then
  echo "Error: input directory does not exist: $input_dir" >&2
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

while IFS= read -r -d '' mp3_file; do
  total=$((total + 1))
  echo
  echo "[$total] Remaking: $mp3_file"

  if "$songgen" remake-lofi "$mp3_file" --out-dir "$out_dir" "$@"; then
    ok=$((ok + 1))
  else
    failed=$((failed + 1))
    echo "Failed: $mp3_file" >&2
  fi
done < <(find "$input_dir" -type f -iname '*.mp3' -print0 | sort -z)

echo
echo "Done. Converted: $ok/$total. Failed: $failed. Output: $out_dir"

if [[ $total -eq 0 ]]; then
  echo "No .mp3 files found in: $input_dir" >&2
  exit 1
fi

if [[ $failed -gt 0 ]]; then
  exit 1
fi
