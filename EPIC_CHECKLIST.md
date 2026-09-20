# The EPIC checklist

Four things every feature epic delivers. A feature that has landed in `libviprs` and
carries none of these is code rather than a shipped feature, and the epic holding it is
not done.

The wording lives here. The mechanism lives in
[`libviprs/libviprs/.github/ISSUE_TEMPLATE/epic.yml`](https://github.com/libviprs/libviprs/blob/main/.github/ISSUE_TEMPLATE/epic.yml),
which puts the four boxes in the issue for you. Tick them against this page, because the
box is one line and the reason it exists is not.

```
[ ] 1. End-to-end tests in libviprs-tests, with fixtures
[ ] 2. Benchmarks captured, against the previous release AND against a comparable library
[ ] 3. CLI commands, so the feature is reachable without writing Rust
[ ] 4. Documentation on libviprs.org, for the feature and for its CLI surface
```

EPIC F is the worked example. PMTiles v3 got all four (the suite in libviprs-tests, the
`storage` benchmark family with its published table, the `viprs pmtiles` group, and the
write-up here), and it got them because the campaign ran long enough to notice they were
missing. Attention is not a gate, which is what this page is for.

---

## 1. End-to-end tests in libviprs-tests, with fixtures

**Where.** [`libviprs-tests`](https://github.com/libviprs/libviprs-tests), as
`tests/<feature>_*.rs` with fixtures committed beside them.

**Not this.** Unit tests inside the `libviprs` crate. Those are worth having and they are
a different thing: they run against internals, in-process, with the crate's own
assumptions. The suite in libviprs-tests runs against a built artefact with real files
underneath it, which is where the interesting failures live. libviprs-tests exists as its
own repository precisely so fixture weight and test-only dependencies never ship to
consumers, so putting the fixtures in the library crate defeats the arrangement.

**The pins.** `COUNTERPART_REV` and `CLI_COUNTERPART_REV` say which `libviprs` and
`libviprs-cli` revisions the suite is written against. Specs land first, then one PR
carries the product change together with the pin bump. Never pin an unmerged head.

**Done when** the new suite fails against the code as it was before the feature and passes
after, and the run is a real run rather than a skip. A host-capability skip is the same
colour as a pass in most runners, so read the artefact rather than the verdict.

**The trap.** A fixture whose value sits on the identity element of the operation under
test cannot fail, and it looks exactly like a fixture that passes. EPIC F measured this
across six archives and 134 reader mutations each: `leaves-z0z7` is blind to **60 of
those 134**, meaning not one of its 21912 probes moves, and it was the only one of the
three original goldens with leaves, so the one test everybody trusted could not have
caught a wrong answer. Before trusting a fixture, work out which cells the mistake would
move and check that a probe lands on one.

The matrix that says this, and the three extra goldens computed to fill the gaps, came out
of the EPIC F campaign scratch rather than a repository, so there is nothing to link here
and a future epic wanting the same answer has to recompute it. That is the argument for
landing the next one somewhere committed.

The second half of the same trap: an oracle that compares against our own reader is not an
oracle. If the reader and the writer share a tile id function, they agree on a wrong answer
and the round trip is green. Compare against something we did not write.

---

## 2. Benchmarks captured, and both comparisons made

**Where.** [`libviprs-bench`](https://github.com/libviprs/libviprs-bench), which keys
everything on a **family**. `engines` compares the three engines, `storage` compares
PMTiles against a directory tree, `vips` compares against libvips `dzsave` behind
`--features libvips`. A new feature usually wants its own family or a profile inside an
existing one.

**Two comparisons, and the second one is the one that gets skipped.**

- **Against the previous libviprs release.** This is the regression check. History lives in
  `report/<family>/benchmark_history.json`, per family, so two families can never append to
  each other's history.
- **Against a comparable library offering the same feature, preferably a C one.** libvips is
  the standing answer and the `vips` family is already wired for it. If nothing comparable
  exists, write down that it does not and why, rather than dropping the row.

Keep it apples to apples. Every engine in the existing comparison writes real PNG tiles to a
real on-disk sink under the same layout, so neither side gets an in-RAM-sink or tile-codec
advantage, and `tests/encoding_claim.rs` proves that from a real run.

**The publish chain**, which is the part that makes a number citable:

```
capture.py on the measurement host
  -> libviprs-bench archive/<family>/, by digest
  -> libviprs-bench tools/publish/history.json
  -> libviprs-org BENCH_REV pin (a full 40-character sha)
  -> node benchmarks/tools/ingest.mjs --bench ../libviprs-bench --sync --rev <sha>
  -> https://libviprs.org/benchmarks/
```

One command for the last step, because the two halves must not be able to come apart.
`--check` is the same verification without the writes and `benchmark-ingest.yml` runs it on
every branch. See [`benchmarks/README.md`](benchmarks/README.md) for what `--check` actually
checks, which is the origin rather than the copy.

**Done when** the numbers are on the page and each one joins an archived document at the
pinned revision by run id.

**Four traps, all of them measured rather than imagined.**

- **A shared builder image is not a baseline.** A warm image may already contain the fix you
  are measuring the absence of. Rebuild from the pin.
- **`rsync -a` gives a stale build.** Preserved mtimes make restored source older than the
  build output, the rebuild is skipped, and the "correct" measurement is the mutation's.
  Build into a virgin artifacts directory.
- **Know the noise floor, and know it is per metric.** It is not one number. On the
  published storage runs the replicate control (one cell measured at six placements
  through the sweep) moves `pmtiles.read_concurrent@4.p50` by 139% and
  `pmtiles.read_random.max` by 89%, so a difference smaller than that metric's own band is
  not a result. `p99` and `max` are ungateable on this suite for exactly that reason. A run
  whose typical cell was not quiet is not publishable and `ingest.mjs` refuses it.
- **A fix sized to its own benchmark moves the cliff rather than removing it.** EPIC F's leaf
  cache was tuned until the case that exposed the bug passed, and the constant it landed on
  bound at 25% of the budget declared in the same PR, so the new bound never bound at all.
  Measured: 16 leaves 0.38us, 17 leaves 7.37us. Test one case past the new value, and check
  the constant against every bound it interacts with.

**Publish the honest number.** PMTiles is slower to generate than a directory tree in every
one of the six published cells, by 15% to 68%, and a cold open costs 90us to 904us against a
tree's 6us to 14us. What it wins is the steady-state read, and it wins it on every cell:
random, plan-order and tile-id-order lookups are all faster, which is the win that actually
carries the epic. The site says all of that, in columns rather than prose. A benchmark page
that only shows the wins is marketing, and nobody trusts the next number on it.

---

## 3. CLI commands

**Where.** [`libviprs-cli`](https://github.com/libviprs/libviprs-cli).

**Done when** somebody can use the feature without writing Rust. The library is the product
and the CLI is a driver over it, so a capability reachable only by adding a dependency and
writing a `main.rs` has shipped to roughly nobody.

**The shape to copy** is the `viprs pmtiles` group: `info`, `tile`, `verify`, `extract`. A
noun for the thing, verbs under it, and each verb doing one job. Where a feature changes a
default, the default moves too: PMTiles became `PyramidStorage::PmTiles` and
`viprs pyramid drawing.tif` now writes `drawing.pmtiles` where it used to write a
`drawing/` tree.

**Get the stream discipline right.** Bytes a caller might pipe into a decoder go to stdout
and every message goes to stderr, including the one for a thing that is not there. A caller
piping tile bytes must not get a sentence where the bytes should be.

**The trap.** A flag that parses and changes nothing. `cli/tools/test-flags` audits every
flag by requiring it to produce a code diff, and it is a required check here for that
reason. A flag with no diff is a flag that does nothing, and it will read as supported for
years.

---

## 4. Documentation on libviprs.org

**Where.** This repository. Two surfaces, and both are required:

- **the feature write-up**, the page that says what the thing is and when to reach for it;
- **the CLI reference** at [`/cli/`](https://libviprs.org/cli/), which indexes every command
  and flag, and links a flag to the test in libviprs-tests that proves it wherever the
  command carries a `@doc-test` marker. Today that is `pyramid` and its 32 flags, so a new
  feature's command is where the next ones come from.

**The CLI reference is generated, not written.** Annotate the command in `libviprs-cli` with
`@doc-snippet` and `@doc-test` markers, the frozen copy under `cli/rust/` re-syncs at
`COUNTERPART_REV` (`cli-resync.yml` opens that as a PR), and the `extract` gate regenerates
`snippets.generated.json` and fails on drift. The contract is
[`cli/SCHEMA_V2.md`](cli/SCHEMA_V2.md).

**Done when** the seven required checks on `main` are green: `sync`, `extract`, `test-flags`,
`gen-op-sections`, `bench-drift`, `msrv` and `links`. The first three are SCHEMA_V2 §5's
gates and `gen-op-sections` gates its §3.2 build step, while `bench-drift`, `msrv` and
`links` have nothing to do with the docs generator, which is worth keeping straight.
`links` is the one that catches a relative path pointing at nothing, and it sits in its own
workflow file rather than in `ci.yml` because adding a job to `ci.yml` reddens the
hook-mirror guard in libviprs-tests.

**The trap.** Hand-editing a generated region. Everything between a `GENERATED:<name>:BEGIN`
marker and its `:END` is rewritten, so an edit there survives until the next regeneration and
then vanishes, and `--check` goes red in the meantime. The same holds for the benchmark JSON:
those files are generated artefacts of `libviprs-bench` and the next republish deletes
anything typed into them by hand. A feature needing its own numbers gets its own export and
its own table, the way PMTiles got `pmtiles_results.json`, rather than extra keys smuggled
into somebody else's.

One more, from the same incident: `ScalabilityPoint` has bare `f64` fields, so an explicit
`null` is a hard deserialize error and `#[serde(default)]` does not rescue it. Default covers
an absent key, not an explicit null.

---

## The shape of the epic itself

At most **2 phases**, and at most **5 issues per phase**. Ten issues is the ceiling. Decide
the phase split before filing anything rather than after.

When the work will not fit, consolidate related packages into one issue and say in that issue
what was folded in, carrying every acceptance criterion across. Meeting the count by dropping
scope is the failure mode, not the goal. If it genuinely cannot fit, that is the signal it is
two epics, so say so rather than quietly adding a phase.

Epics that predate this rule keep their shape. Any new phase or issue added to one still
respects the per-phase limit.

## What this does not replace

The per-issue workflow still applies to every issue inside the epic: draft PR first, tests
red before the fix, a closing keyword pointed at the issue and **never** at the epic, and an
adversarial review before merge. This page is about what the epic owes as a whole. That one
is about how each piece of it lands.

Two more worth repeating here because they bite at the seam between repos:

- **Compose before merge.** Put every open branch on one scratch branch and run the full gate
  before merging any of them. EPIC F caught two PRs that could not complete each other, each
  correct alone, because one published rows on a 16:9 grid at concurrency 1 and 10 while the
  other measured square canvases at concurrency 1 and 2 to 8. Empty intersection, and the
  epic would have closed on a deliverable nothing could fill.
- **Zero open issues means done.** Code landing is not the issue resolving. An epic with an
  open sub-issue is an open epic, whatever has merged.
