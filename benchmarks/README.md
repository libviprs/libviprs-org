# Where the numbers on /benchmarks/ come from

Nothing in this directory is measured here, and `history.json` is not this
repository's file to edit.

`libviprs-bench` captures on the measurement host through its own
`tools/capture.py`, archives each document by digest under `archive/<family>/`,
imports it into `tools/publish/history.json` and commits both. That repository is
where a benchmark number exists. This one draws it.

- **`BENCH_REV`** pins one libviprs-bench commit, as a full 40-character sha.
- **`history.json`** is a frozen copy of that revision's
  `tools/publish/history.json`, the way `cli/rust/` is a frozen copy of
  libviprs-cli at `COUNTERPART_REV`.
- **`index.html`** is generated from `history.json` by `tools/render-latest.mjs`.
  Everything between a `GENERATED:<name>:BEGIN` marker and its `:END` is
  rewritten; hand-edit any of it and `--check` goes red.

## Moving the page to a newer capture

```
node benchmarks/tools/ingest.mjs --bench ../libviprs-bench --sync --rev <sha>
```

One command, because the two halves must not be able to come apart: it verifies
the origin, refuses before it writes anything, takes the history and regenerates
the page. `--check` is the same verification without the writes, and
`benchmark-ingest.yml` runs it on every branch.

## What --check actually checks

Not that the copy matches. A copy that matches proves the copy is a copy, and a
history edited in both places would sail through that. So it checks the origin,
and it checks it over the entries in `history.json` itself, because that is the
file the page is generated from; the byte comparison with the pinned original
comes after. Every entry has to join an archived document at the pinned revision
by run id,
that document's four integrity digests are recomputed with the pinned revision's
own canonicaliser and have to equal both the entry's `integrity` block and the
archive index's row, and the document has to still pass the rules that let it be
published at all: not emulated, release build, clean tree, publishable profile,
and a run whose typical cell was quiet.

That last part is not tidiness. Before this existed, the two entries the page
drew named run ids that no document in `libviprs-bench/archive/` carried, so the
live figures could not be checked against the artefacts they came from.

## Why a pin rather than following libviprs-bench main

Following main would mean a capture publishes itself, with no commit here. It is
the nicer automation and the wrong trade for this project: the discipline
everywhere else is that a published number is tied to something you can go and
check, and "which benchmark revision is this page showing" has to be answerable
from this repository alone, from a file, without asking another repository what
its `main` happened to be on the day.

The cost is real and is the cost: a capture does not reach the site until
somebody bumps the pin. `benchmark-release.yml` is that somebody, and takes the
revision as an input.

## The libvips article

`benchmarks/libvips/` is unrelated to all of this. It is the same hand-written
comparison article it always was, guarded by `tools/bench-drift.js`.
