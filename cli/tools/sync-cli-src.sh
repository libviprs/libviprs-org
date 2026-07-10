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
CANONICAL="$SCRIPT_DIR/../../../libviprs-cli/src/main.rs"
COPY="$SCRIPT_DIR/../rust/main.rs"

CHECK=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK=1
elif [[ $# -gt 0 ]]; then
  echo "error: unknown argument '$1' (expected --check or no argument)" >&2
  exit 2
fi

if [[ ! -f "$CANONICAL" ]]; then
  echo "error: canonical source not found at $CANONICAL" >&2
  echo "       check out libviprs/libviprs-cli as a sibling of this repo." >&2
  exit 1
fi

if [[ "$CHECK" -eq 1 ]]; then
  # Diff-only drift guard: the frozen copy must be byte-identical to the
  # canonical source. Writes nothing; leaves the working tree untouched.
  if diff -u "$COPY" "$CANONICAL"; then
    echo "check ok: frozen CLI copy is in sync with $CANONICAL"
    exit 0
  fi
  echo "error: $COPY has drifted from canonical $CANONICAL" >&2
  echo "       run cli/tools/sync-cli-src.sh (without --check) and commit the result." >&2
  exit 1
fi

cp "$CANONICAL" "$COPY"
echo "synced $CANONICAL -> $COPY"

cd "$SCRIPT_DIR/extract-snippets"
cargo run --quiet
