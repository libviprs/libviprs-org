#!/usr/bin/env bash
#
# Sync the canonical libviprs-cli/src/main.rs into the doc site's frozen copy
# at libviprs-org/cli/rust/main.rs, then re-run every generator that reads it, so
# libviprs-org/cli/js/snippets.generated.json, the gen-op-sections fragment and
# the published cli/index.html all reflect the latest source.
#
# Run this whenever libviprs-cli/src/main.rs changes (annotation markers
# included).
#
# Usage:
#   sync-cli-src.sh            # copy canonical -> frozen copy, regenerate everything
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
# every .rs under ops/, AT ANY DEPTH. Relative paths under src/ -> under rust/.
#
# SCHEMA_V2 §5.1 writes that set as `src/ops/*.rs` and this function used to be
# a literal `ls ops/*.rs`, which is a flat glob. libviprs-cli d51dbc5 turned
# ops/arithmetic.rs into the directory module ops/arithmetic/{mod,part_a,part_b}.rs
# and the glob stopped seeing it. Nothing went red, because the enumeration and
# the comparison are the same list: a file the glob does not name is a file the
# diff never asks about. At pin 23f85a8c the gate printed "check ok: frozen CLI
# copy is in sync" while three canonical files had no frozen copy at all, and
# cli/rust/ops/mod.rs declares `pub mod arithmetic;` and calls
# arithmetic::commands, so it is not as if the family were absent from the copy
# on purpose.
#
# That is the same shape as libviprs-org#72 in the same job: a thing that reads
# as configured, is not, and whose absence happens to be survivable. Depth is
# the only thing that changed here, so `find` rather than a glob, and the depth
# of a canonical file is now the copy's problem instead of the gate's blind
# spot.
collect_rel_files() {
  (
    cd "$CANONICAL_SRC"
    printf '%s\n' main.rs
    if [[ -d ops ]]; then
      find ops -type f -name '*.rs' | LC_ALL=C sort
    fi
  )
}

# The other direction. collect_rel_files walks the canonical side, so a frozen
# file the canonical has since deleted is never named and never compared: it
# sits in cli/rust/ being byte-identical to nothing. Enumerating the frozen side
# as well is what makes "byte-identical copy" mean both halves.
#
# --check reports an orphan and stops; the write path does not delete it. A file
# disappearing from libviprs-cli is a change somebody should look at, and
# cli-resync.yml already has the escalation for a gate its re-sync cannot
# satisfy on its own: the job fails and the failure step opens an issue.
collect_frozen_files() {
  ( cd "$FROZEN_DIR" && find . -type f -name '*.rs' | sed 's|^\./||' | LC_ALL=C sort )
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
  # Orphans: a frozen .rs with no canonical counterpart.
  canon_list="$(collect_rel_files)"
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    if ! printf '%s\n' "$canon_list" | grep -Fxq -- "$rel"; then
      echo "error: $FROZEN_DIR/$rel has no counterpart in $CANONICAL_SRC" >&2
      echo "       libviprs-cli no longer has src/$rel. Remove the frozen copy in the same" >&2
      echo "       change that explains why the command went away." >&2
      drift=1
    fi
  done < <(collect_frozen_files)

  # A count, not just a verdict. "check ok" with an enumeration that quietly
  # named nothing is precisely how the flat glob stayed green for three files,
  # so the line that says it passed also says what it looked at.
  n_canon="$(printf '%s\n' "$canon_list" | grep -c . || true)"
  if [[ "$drift" -eq 0 ]]; then
    echo "check ok: $n_canon frozen file(s) byte-identical to $CANONICAL_SRC"
    exit 0
  fi
  echo "       run cli/tools/sync-cli-src.sh (without --check) and commit the result." >&2
  exit 1
fi

# Everything below writes. The op sections need node, so fail before touching the
# tree rather than half-way through it.
if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found; it is needed to regenerate the op sections." >&2
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

# The data-driven op sections are generated FROM snippets.generated.json, so a
# re-sync that lands inside a @doc-snippet slot moves them too. Regenerating the
# manifest alone is not enough: the gen-op-sections gate diffs the committed
# fragment, so stopping here leaves that gate red and the drift error above
# telling you to run a command that cannot clear it. $SCRIPT_DIR is absolute, so
# the cd above does not reach these.
GEN_OP_SECTIONS="$SCRIPT_DIR/gen-op-sections/index.js"
node "$GEN_OP_SECTIONS" --out "$SCRIPT_DIR/gen-op-sections/generated-op-sections.html"
# ... and the published page embeds the same fragment between its BEGIN/END
# markers, so it goes stale in exactly the same way. Nothing in CI diffs it,
# which is why it has to be regenerated here.
node "$GEN_OP_SECTIONS" --inject "$SCRIPT_DIR/../index.html"
