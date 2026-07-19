#!/usr/bin/env bash
#
# Sync the canonical libviprs-cli/src/main.rs into the doc site's frozen copy
# at libviprs-org/cli/rust/main.rs, then re-run the extractor so
# libviprs-org/cli/js/snippets.generated.json reflects the latest source.
#
# Run this whenever libviprs-cli/src/main.rs changes (annotation markers
# included).
#
# Usage:
#   sync-cli-src.sh            # copy canonical -> frozen copy, regenerate JSON
#   sync-cli-src.sh --check    # assert nothing drifted; write nothing; exit 1 on drift
#
# --check is the drift guard CI runs. It is diff-only: it asserts the frozen
# copy is byte-identical to the canonical libviprs-cli source and touches
# nothing on disk. This is what keeps the client-side `#flag-*` --help anchors
# from silently breaking after a skipped sync. The companion flag-anchor test
# (cli/tools/test-flags/anchors.js) checks that every `#flag-<name>` link in
# the frozen copy resolves to a flag in snippets.generated.json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANONICAL_SRC="$SCRIPT_DIR/../../../libviprs-cli/src"
FROZEN_DIR="$SCRIPT_DIR/../rust"

CHECK=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK=1
elif [[ $# -gt 0 ]]; then
  echo "error: unknown argument '$1' (expected --check or no argument)" >&2
  exit 2
fi

if [[ ! -f "$CANONICAL_SRC/main.rs" ]]; then
  echo "error: canonical source not found at $CANONICAL_SRC/main.rs" >&2
  echo "       check out libviprs/libviprs-cli as a sibling of this repo." >&2
  exit 1
fi

# The set of canonical files that make up the frozen doc copy: main.rs plus
# every ops/*.rs (SCHEMA_V2 §5.1). Relative paths under src/ -> under rust/.
collect_rel_files() {
  ( cd "$CANONICAL_SRC" && printf '%s\n' main.rs $( [[ -d ops ]] && ls ops/*.rs 2>/dev/null || true ) )
}

if [[ "$CHECK" -eq 1 ]]; then
  # Diff-only drift guard: every frozen copy must be byte-identical to the
  # canonical source. Writes nothing; leaves the working tree untouched.
  drift=0
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    canon="$CANONICAL_SRC/$rel"
    copy="$FROZEN_DIR/$rel"
    if [[ ! -f "$copy" ]]; then
      echo "error: frozen copy missing: $copy (canonical has $canon)" >&2
      drift=1
      continue
    fi
    if ! diff -u "$copy" "$canon"; then
      echo "error: $copy has drifted from canonical $canon" >&2
      drift=1
    fi
  done < <(collect_rel_files)
  if [[ "$drift" -eq 0 ]]; then
    echo "check ok: frozen CLI copy is in sync with $CANONICAL_SRC"
    exit 0
  fi
  echo "       run cli/tools/sync-cli-src.sh (without --check) and commit the result." >&2
  exit 1
fi

while IFS= read -r rel; do
  [[ -z "$rel" ]] && continue
  mkdir -p "$(dirname "$FROZEN_DIR/$rel")"
  cp "$CANONICAL_SRC/$rel" "$FROZEN_DIR/$rel"
  echo "synced $CANONICAL_SRC/$rel -> $FROZEN_DIR/$rel"
done < <(collect_rel_files)

cd "$SCRIPT_DIR/extract-snippets"
cargo run --quiet
