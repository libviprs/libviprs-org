#!/usr/bin/env bash
#
# Sync the canonical libviprs-cli/src/main.rs into the doc site's frozen copy
# at libviprs-org/cli/rust/main.rs, then re-run the extractor so
# libviprs-org/cli/js/snippets.generated.json reflects the latest source.
#
# Run this whenever libviprs-cli/src/main.rs changes (annotation markers
# included). CI can also assert the two files match to catch drift.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANONICAL="$SCRIPT_DIR/../../../libviprs-cli/src/main.rs"
COPY="$SCRIPT_DIR/../rust/main.rs"

if [[ ! -f "$CANONICAL" ]]; then
  echo "error: canonical source not found at $CANONICAL" >&2
  exit 1
fi

cp "$CANONICAL" "$COPY"
echo "synced $CANONICAL -> $COPY"

cd "$SCRIPT_DIR/extract-snippets"
cargo run --quiet
