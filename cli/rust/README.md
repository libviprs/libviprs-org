# `cli/rust/`

Frozen, byte-identical copy of [`libviprs-cli/src`](../../../libviprs-cli/src):
`main.rs` plus every `.rs` under `ops/`, at any depth. Refreshed by
[`../tools/sync-cli-src.sh`](../tools/sync-cli-src.sh), and
`COUNTERPART_REV` names the libviprs-cli revision it is a copy of.

At any depth is the operative part and it is not decorative. The copy and the
`--check` that guards it both used to walk a flat `ops/*.rs`, so when
libviprs-cli turned `ops/arithmetic.rs` into `ops/arithmetic/`, three files
stopped being copied and the gate reported the copy in sync, because the
enumeration it compares is the enumeration it makes (libviprs-org#72's PR).

The files are **input data** for [`../tools/extract-snippets`](../tools/extract-snippets), not a build target.
They deliberately do not belong to any crate — the extractor reads them as text,
walking the `// @doc-snippet:` / `// @doc-flag:` / `// @doc-test:` comment
markers to emit [`../js/snippets.generated.json`](../js/snippets.generated.json).

If your editor surfaces a rust-analyzer `unlinked-file` diagnostic on these
files, that is expected. Suppress it with:

```jsonc
// .vscode/settings.json (or your editor's equivalent)
"rust-analyzer.diagnostics.disabled": ["unlinked-file"]
```
