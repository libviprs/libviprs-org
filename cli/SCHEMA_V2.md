# Docs-generator SCHEMA v2 — FROZEN (Wave 0 gate)

> Frozen jointly by Agent A + Agent B per `CLI_CONTRACT.md` §0, §4, §6, §7-docs.
> Governs `cli/tools/extract-snippets` (Rust), `cli/js/*` (consumers),
> `viprs __dump-commands --json` (CLI introspection), and the `libviprs-org` CI.
> Nothing in Waves 1+ may contradict this file or `libviprs-cli/OP_MAP.md`.

This spec exists to fix the concrete v1 defects the contract calls out:
v1 hardcodes `VERSION=1`, `COMMAND="pyramid"`, reads ONE file, uses FLAT global
slot/flag maps (so `--width` in `test-image` and a future `black` collide),
hardcodes `SLOT_ORDER`/`IMPORTS_BASE`, and every JS consumer is pyramid-shaped.
v2 makes the manifest **command-scoped** and adds a **data-generated** path for
the ~180 op commands, while keeping pyramid's interactive live-generator and its
existing annotated source **byte-for-byte unchanged**.

---

## 1. Grammar v2 — annotations

### 1.1 Marker set (superset of v1; v1 markers stay valid)

```
// @doc-command:begin name=<cmd> [about="..."] \
//     slot-order=<slot,slot,...> imports-base=<Sym,Sym,...>
// @doc-command:end name=<cmd>

// @doc-snippet:begin command=<cmd> slot=<name> [imports=<Sym,Sym,...>]
// ... captured Rust lines ...
// @doc-snippet:end command=<cmd> slot=<name>

<rust code> // @doc-flag: <flag> command=<cmd> kind=<param|append|appendChain|override|imports-only> [param_name=<name>] [imports=...] [special=...]
<rust code> // @doc-test: <file>::<fn>:<line> [repo=<libviprs-tests|libviprs-cli|libviprs>]
```

* `<cmd>` is the **exact vips nickname** (the clap command name, `CLI_CONTRACT.md`
  §1) — `pyramid`, `erode`, `extract_band`, `draw_circle`, …
* `<slot>` names are unique **within a command only** (see §1.3).
* Attribute syntax is the v1 `key=value`, whitespace-separated, values contain no
  whitespace — **except** `about="..."` on `@doc-command`, the one quoted value
  (parsed to the closing quote so it may contain spaces).

### 1.2 Command scoping — the `command=` attribute

Every `@doc-snippet:begin`/`:end` and every `@doc-flag:` MAY carry
`command=<cmd>`. Resolution order for the owning command of a line:

1. explicit `command=` on the marker;
2. else the `command` of the slot at the top of the active snippet stack
   (a `@doc-flag` inside an open snippet inherits that snippet's command);
3. else the **built-in default `pyramid`**.

Rule (3) is load-bearing for the baseline invariant (§4): the frozen pyramid
`main.rs` carries **no** `command=` attribute and **no** `@doc-command` block, so
every existing pyramid marker resolves to `command=pyramid` unchanged — the
frozen source is never edited (`CLI_CONTRACT.md` §6).

### 1.3 Per-command namespacing of slots AND flags

The extractor keys everything by `(command, id)`:

* `slots` becomes `BTreeMap<Command, BTreeMap<SlotId, Slot>>`.
* `flags` becomes `BTreeMap<Command, BTreeMap<FlagId, Flag>>`.

A slot id or flag id is unique **only within its command**. Therefore
`test-image --width` and `black --width` are `commands["test-image"].flags["width"]`
and `commands["black"].flags["width"]` — **the v1 `--width` collision is
structurally impossible in v2**. Likewise two ops may both declare `slot=apply`.

### 1.4 `@doc-command` — per-command `slot_order` / `imports_base`

v1's hardcoded `SLOT_ORDER` and `IMPORTS_BASE` consts are **removed**. A command's
`slot_order` and `imports_base` are sourced from its `@doc-command` block:

```rust
// @doc-command:begin name=erode about="Erode with a morphological mask" \
//     slot-order=load,apply,save imports-base=decode_file,save_file,Morphology
```

Sourcing rules per command:

* If a `@doc-command` block exists → use its `slot-order` / `imports-base` verbatim.
* If **no** `@doc-command` block exists AND the command is `pyramid` → use the
  built-in **PYRAMID fallback** (the current v1 constants, retained solely so the
  frozen pyramid source needs no `@doc-command`; see §4).
* If no `@doc-command` block exists for any **other** command that nonetheless
  produced slots/flags → **hard error** (exit 1): `command '<cmd>' has snippets
  but no @doc-command block declaring slot-order/imports-base`. This forces every
  new op family to declare its command metadata explicitly.

`slot-order` MUST list exactly the slot ids that command defines (extractor errors
on a slot referenced in `slot-order` but never opened, or a slot opened but absent
from `slot-order`). `imports-base` is the base `use libviprs::{…}` set the JS
generator unions with each active flag's `imports_when_active`.

### 1.5 One family `.rs` file holding many ops

A single `ops/<family>.rs` (e.g. `ops/morphology.rs`) exports several vips ops.
It carries **one `@doc-command` block per op** and interleaves their snippets
freely; the extractor demultiplexes by the `command=` attribute:

```rust
// @doc-command:begin name=erode  slot-order=load,apply,save imports-base=decode_file,save_file
// @doc-command:begin name=dilate slot-order=load,apply,save imports-base=decode_file,save_file

    // @doc-snippet:begin command=erode slot=apply
    let out = raster.try_erode(&mask)?;      // @doc-flag: mask command=erode kind=param param_name=mask
    // @doc-snippet:end command=erode slot=apply

    // @doc-snippet:begin command=dilate slot=apply
    let out = raster.try_dilate(&mask)?;     // @doc-flag: mask command=dilate kind=param param_name=mask
    // @doc-snippet:end command=dilate slot=apply
```

Both ops define `slot=apply` and `--mask` with zero collision. The parser's active
stack tracks `(command, slot)` pairs, so a captured line is routed to
`commands[stack.top().command].slots[stack.top().slot]`.

### 1.6 Most op commands are NOT annotated

Per `CLI_CONTRACT.md` §4, op handlers are 3-line `load → try_op → save` bodies;
hand-authoring interactive machinery for ~180 of them is infeasible. Only pyramid
(and the morphology **reference** family, Wave 1) carry `@doc-snippet` annotations.
Every other op command is **data-generated** from `viprs __dump-commands --json`
(§3). Such commands do **not** appear in `snippets.generated.json` unless
annotated; the build step generates their HTML directly from the dump.

---

## 2. JSON schema v2 — `snippets.generated.json`

### 2.1 Top-level shape

```json
{
  "version": 2,
  "commands": {
    "pyramid": {
      "interactive": true,
      "about": "Generate a tile pyramid from a PDF or image file.",
      "imports_base": ["EngineBuilder", "EngineConfig", "FsSink", "Layout",
                       "PyramidPlanner", "TileFormat", "decode_file"],
      "slot_order": ["tracing-init", "load-source", "planner", "memory-limit",
                     "geo", "sink", "engine-config", "engine-builder", "finish"],
      "slots": { "<slot-id>": { /* Slot */ }, ... },
      "flags": { "<flag-id>": { /* Flag */ }, ... }
    },
    "erode": {
      "interactive": false,
      "about": "Erode with a morphological mask",
      "imports_base": ["decode_file", "save_file", "Morphology"],
      "slot_order": ["load", "apply", "save"],
      "slots": { ... },
      "flags": { ... }
    }
  }
}
```

* `version` is the integer `2`.
* v1's top-level `command`, `imports_base`, `slot_order`, `slots`, `flags` keys are
  **gone**; they now live *inside* each `commands[<cmd>]` object.
* `interactive` (bool): `true` only for `pyramid` (keeps the live generator);
  `false` for annotated op families. The site build step uses this to decide
  hand-authored-interactive vs data-generated rendering.
* `about` (string, optional): from `@doc-command about="..."`; may be omitted.
* Commands are emitted in sorted key order (deterministic bytes for the CI
  byte-identical check, §5).

### 2.2 `Slot` object (unchanged from v1, now nested per command)

```json
{
  "imports_when_active": ["GeoCoord", "GeoTransform"],
  "lines": ["let planner = PyramidPlanner::new(", "    raster.width(),", ...],
  "gated_by": ["memory-limit"]        // optional; slot renders only if a gate flag is active
}
```

### 2.3 `Flag` object (unchanged fields; `test.repo` becomes tri-state)

```json
{
  "kind": "param",                     // param | append | appendChain | override | imports-only
  "slot": "planner",
  "param_name": "tile-size",           // present for kind=param
  "type": "int",                       // int | str | bool | enum
  "options": ["deep-zoom", "xyz"],     // present for type=enum
  "default": "256",
  "cli": "--tile-size {v}",
  "fragment": "",
  "imports_when_active": [],
  "special": "sink-override",          // optional
  "test": {
    "file": "blank_tile_strategy.rs",
    "fn": "emit_solid_white_matches_expected",
    "line": 138,
    "repo": "libviprs-tests"           // TRI-STATE — see §2.4
  }
}
```

### 2.4 `TestRef.repo` — tri-state

`repo` is one of `libviprs-tests` | `libviprs-cli` | `libviprs`. Resolution:

1. explicit `repo=` token on the `@doc-test` marker wins;
2. else path heuristic:
   * `src/…` or `./src/…`  → `libviprs`   (core crate)
   * `tests/cli_e2e…`, or a `cli:`-prefixed file token → `libviprs-cli`
     (the only crate where `CARGO_BIN_EXE_viprs` is set, `CLI_CONTRACT.md` §0)
   * otherwise → `libviprs-tests`.

The JS `buildTestHref` gains a third branch:

| repo | base URL |
|---|---|
| `libviprs-tests` | `https://github.com/libviprs/libviprs-tests/blob/main/tests/<file><#L…>` |
| `libviprs-cli`   | `https://github.com/libviprs/libviprs-cli/blob/main/<file><#L…>` |
| `libviprs`       | `https://github.com/libviprs/libviprs/blob/main/<file><#L…>` |

---

## 3. `viprs __dump-commands --json` — clap-introspection contract

A **hidden** subcommand (`#[command(hide = true)]`, name `__dump-commands`) that
walks the assembled clap `Command` tree (the per-family `commands()` registry,
`CLI_CONTRACT.md` §6) and prints one JSON document to stdout. It performs **no**
image work, touches no PDF paths (pdfium-free), and is safe to run in the docs
build.

### 3.1 Output shape

```json
{
  "viprs_version": "0.4.1",
  "generated_by": "viprs __dump-commands",
  "commands": [
    {
      "name": "extract_band",
      "about": "Extract a band (channel) from an image.",
      "family": "conversion",
      "shape": "image->image",
      "oracle_class": "EXACT",
      "positionals": [
        { "name": "IN",  "index": 1, "required": true,  "help": "Input image" },
        { "name": "OUT", "index": 2, "required": true,  "help": "Output image" }
      ],
      "flags": [
        {
          "long": "band", "short": "b", "value_name": "BAND",
          "takes_value": true, "multiple": false, "required": false,
          "default": "0", "possible_values": null,
          "help": "Band index to extract"
        },
        {
          "long": "n", "short": null, "value_name": "N",
          "takes_value": true, "multiple": false, "required": false,
          "default": "1", "possible_values": null,
          "help": "Number of bands"
        }
      ]
    }
  ]
}
```

Field notes:

* `name` — exact clap command name (= vips nickname).
* `family`, `shape`, `oracle_class` — carried from `OP_MAP.md` via a small
  per-command attribute the family registry attaches (or a static side table keyed
  by name); `shape` is one of the six §3 shapes, `oracle_class` one of §5.
* `positionals[]` — in clap declaration order (`index` 1-based, matching vips
  positional order per `CLI_CONTRACT.md` §3, incl. the OUT-first creator shape and
  two-output shape).
* `flags[]` — every non-positional arg: `long`, `short|null`, `value_name`,
  `takes_value`, `multiple`, `required`, `default|null`, `possible_values|null`
  (enum choices), `help`. Decode-limit flags (`--max-width` … `--max-alloc-bytes`,
  `CLI_CONTRACT.md` §2) appear here like any other.
* Commands sorted by `name` for stable bytes.
* `pyramid`/`info`/`plan`/`test-image` ARE included in the dump (they are real
  clap commands) but the build step skips generation for `interactive:true`
  commands (§3.2) — their HTML stays hand-authored.

### 3.2 Site build step (`tools/gen-op-sections`)

A new node script consumes the dump **plus** the v2 manifest and generates, for
each non-interactive command:

1. a per-command HTML `<section>` (same visual style as the hand-authored
   sections: `<h2 id="<name>">`, an `about` paragraph, a `<dl class="flags">` of
   positionals + flags with defaults/help, anchor-linked as
   `libviprs.org/cli/#<name>` and per-flag `#<name>-flag-<long>`);
2. a **static Rust ↔ CLI example pair** — the CLI line synthesized from
   positionals + a representative flag or two, and the Rust body from the op's
   annotated snippet if present (`commands[<cmd>]` in the manifest) or a generated
   `load → try_<op> → save` template otherwise.

Interactive commands (`pyramid`, and the hand-authored `info`/`plan`/`test-image`)
are **excluded** from generation — the build step leaves their HTML untouched and
injects generated op sections into a designated container (§6). This is the
contract's "extend generator to all commands" = **data-driven generation**, not
per-op hand-written HTML or per-op interactivity.

---

## 4. PYRAMID-BASELINE invariant (fail-loud regression guard)

The v2 extractor MUST emit `commands["pyramid"]` **byte-equivalent** (modulo the
new nesting under `commands.pyramid`) to what v1 emits today. The baseline is the
committed `cli/js/snippets.generated.json` projected into the pyramid command.

### 4.1 Frozen baseline values (from the committed v1 JSON)

* **`slot_order`** (exactly, in order — 9 slots):
  `tracing-init, load-source, planner, memory-limit, geo, sink, engine-config,
  engine-builder, finish`
* **`imports_base`** (exactly — 7 symbols):
  `EngineBuilder, EngineConfig, FsSink, Layout, PyramidPlanner, TileFormat,
  decode_file`
* **flag count ≥ 31**, and the 31 baseline flag ids MUST all be present:
  `blank-tolerance, buffer-size, centre, checksum-algo, concurrency, dedupe-all,
  dedupe-blanks, dpi, failure-policy, format, geo-origin, geo-scale, layout,
  manifest-emit-checksums, match-page-size, memory-budget, memory-limit, overlap,
  overwrite, page, parallel, quality, render, resume, retry-backoff, retry-max,
  sink, skip-blank, tile-size, trace-level, verify`
* **9 slots present** with the same ids as `slot_order`.

These are encoded as a `PYRAMID_BASELINE` constant in `extract-snippets`, and this
same constant doubles as the **PYRAMID fallback** of §1.4 (so an un-annotated
pyramid source still yields the frozen `slot_order`/`imports_base`).

### 4.2 How the build fails loudly

After parsing, before writing the JSON, the extractor runs `assert_pyramid_baseline()`
and exits **non-zero with a diagnostic** if any of these regress:

* `commands["pyramid"]` missing → `error: pyramid command absent from manifest`.
* `slot_order != BASELINE.slot_order` → prints the diff (`missing: […]`, `extra: […]`, or `reordered`).
* any baseline flag id missing → `error: pyramid regressed: missing flags […]`.
* `flags.len() < 31` → `error: pyramid flag count 27 < baseline 31`.
* `imports_base != BASELINE.imports_base` → prints the symbol diff.

CI additionally re-runs the extractor and asserts `git diff --exit-code` on
`snippets.generated.json` is clean (§5), so any pyramid drift — even one that still
passes the count/id asserts — is caught as an uncommitted-regeneration diff.

---

## 5. Minimal `libviprs-org` CI (repo has NO CI today)

Add `.github/workflows/ci.yml` (ubuntu-latest, Rust stable + Node LTS). Three
gates, matching `CLI_CONTRACT.md` §6:

### 5.1 `sync` — byte-identical check
Check out `libviprs-org` **and** `libviprs-cli` at the pinned `CLI_COUNTERPART_REV`
(§7). Run `cli/tools/sync-cli-src.sh --check` (new `--check` mode: copies to a temp
path and `diff`s the canonical `libviprs-cli/src/main.rs` (+ `src/ops/*.rs`) against
the committed `cli/rust/*`). Fail if any byte differs — the frozen doc copy is
stale. (When `libviprs-cli` is not available to the workflow, this job is
`continue-on-error` with a warning; the extractor + test-flags gates below still run
against the committed copy.)

### 5.2 `extract` — non-empty + baseline + no-drift
```
cargo run --manifest-path cli/tools/extract-snippets/Cargo.toml
git diff --exit-code cli/js/snippets.generated.json    # committed JSON matches regen
```
The extractor itself enforces §4 (baseline + non-empty: `commands.pyramid`
present, ≥31 flags, 9 slots) and exits non-zero on regression. `git diff
--exit-code` catches any un-regenerated drift.

### 5.3 `test-flags` — per-flag audit gate
```
node cli/tools/test-flags/test.js        # exit 1 if any flag produces zero diff
```
Runs the v2-aware audit (§6) over `commands.pyramid` (and any other
`interactive`/annotated command). Zero broken flags required to pass.

All three gates are required checks on `main`.

---

## 6. Migration notes — what changes, with effort

### 6.1 Rust — `cli/tools/extract-snippets/src/main.rs`  (~1.5 days)

* **Remove** `const VERSION: u32 = 1`, `const COMMAND`, `const IMPORTS_BASE`,
  `const SLOT_ORDER`. Add `const VERSION: u32 = 2` and a `PYRAMID_BASELINE`
  (slot_order + imports_base + the 31 flag ids), reused as the pyramid fallback.
* **Data model**: introduce `struct Command { about, interactive, imports_base,
  slot_order, slots: BTreeMap<String,Slot>, flags: BTreeMap<String,Flag> }`.
  `parse()` returns `BTreeMap<String, Command>` keyed by command name.
* **Stack**: change `stack: Vec<String>` (slot ids) → `Vec<(String,String)>`
  (command, slot). `@doc-snippet:begin` resolves command via §1.2; captured lines
  route to `commands[cmd].slots[slot]`.
* **`@doc-command` directive**: new `parse_command_header()` producing `about /
  slot-order / imports-base`; the `about="..."` quoted-value case is the one
  addition to `parse_attrs`.
* **`@doc-flag`**: read `command=` (fall back to active snippet's command, then
  `pyramid`); insert into `commands[cmd].flags`.
* **`parse_test_ref`**: honor an explicit `repo=` token; extend the heuristic to
  the tri-state of §2.4 (add the `libviprs-cli` branch).
* **Multi-file input**: read `cli/rust/main.rs` **and** `cli/rust/ops/*.rs`
  (glob, sorted); parse each and merge into the same `commands` map (command
  scoping makes the merge conflict-free). Keep the "missing file → warn, continue"
  tolerance per file, but **error if the merged map is empty**.
* **`build_manifest`**: emit `{version:2, commands:{…}}`; apply the PYRAMID
  fallback and run `assert_pyramid_baseline()` (§4.2) before serialization; error
  on any non-pyramid command lacking `@doc-command`.
* Update the `#[cfg(test)]` unit tests: existing cases become command-scoped
  (assert under `commands["pyramid"]`); add cases for command scoping, `--width`
  non-collision across two commands, `@doc-command` sourcing, tri-state repo, and
  the baseline assert firing on a deliberately-truncated input.

### 6.2 JS — `cli/js/cli.js`  (~0.5 day)

* `loadSnippets()`: after fetch, keep the full doc on `window.VIPRS_MANIFEST` and
  set `window.VIPRS_SNIPPETS = data.commands.pyramid`. **Every downstream pyramid
  function (`ensureFlagColors`, `renderFullProgram`, `flagsForRawLine`,
  `gatherOtherDefaults`, `updateGenerator`, slot/flag/imports_base/slot_order
  reads) then works unchanged** — they already read `snippets.flags`,
  `snippets.slots`, `snippets.slot_order`, `snippets.imports_base`, which now point
  at the pyramid command object. This is the key that keeps the interactive layer a
  ~3-line change.
* `buildTestHref()`: add the `libviprs-cli` branch (§2.4).
* `pyramidSection`/`pyramidDts` and the hand-authored pyramid HTML are unchanged
  (pyramid stays interactive and hand-authored).

### 6.3 JS — `cli/js/checklist.js` and `cli/js/code-gutter.js`  (~0 day)

* `checklist.js` is pyramid-specific and drives off the generator state object /
  live `dt` rows, not the manifest shape → **no change**.
* `code-gutter.js` consumes only the `prog` object (`rustLines`, `activeFlags`,
  `flagColors`) → command-agnostic, **no change**.

### 6.4 JS — `cli/tools/test-flags/test.js`  (~0.5 day)

* Read the v2 doc and iterate over `Object.keys(json.commands)` where
  `interactive || has slots`, running the existing per-flag audit against each
  command's `{slots, flags, slot_order, imports_base}`. For Wave 1 it may audit
  just `commands.pyramid`; keep the loop so op families are covered as they land.

### 6.5 HTML — `cli/index.html`  (~1 day incl. new gen script)

* Hand-authored `pyramid` (`#cli-generator`, base-setup, flag `<dl>`s), `info`,
  `plan`, `test-image` sections **stay as-is**.
* Add a single injection container (e.g. `<div id="generated-op-sections"></div>`)
  where `tools/gen-op-sections` writes the data-generated per-command sections
  (§3.2). The generator is a new node script; index.html itself changes only by
  adding the container + a build-time include. Op-section CSS reuses existing
  `.flags`/`dl`/`code-wrap` styles, so styling polish is incremental, not blocking.

### 6.6 Effort summary

| Area | Effort |
|---|---|
| extract-snippets v2 (parser + baseline + multi-file + tests) | ~1.5 d |
| cli.js command-select + tri-state href | ~0.5 d |
| test-flags v2 loop | ~0.5 d |
| `__dump-commands` consumer + `gen-op-sections` first cut | ~1 d |
| libviprs-org CI (3 gates) | ~0.5 d |
| checklist.js / code-gutter.js | 0 |
| **Total (Wave 1, Agent B)** | **~4 engineer-days** |

The `__dump-commands` clap subcommand itself is owned by Agent A (CLI side), not
counted above; the docs build consumes its JSON.

---

## 7. Pin/version order (recap from `CLI_CONTRACT.md`)

Bump order on any coupled change: **core → cli → org → tests**. `libviprs-org`
pins the CLI SHA it synced from via `CLI_COUNTERPART_REV` (used by the §5.1 sync
gate). The `version:2` integer in the manifest is the schema version and changes
only via a new frozen revision of this file.
