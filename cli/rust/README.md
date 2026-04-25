# `cli/rust/main.rs`

Frozen, byte-identical copy of [`libviprs-cli/src/main.rs`](../../../libviprs-cli/src/main.rs).
Refreshed by [`../tools/sync-cli-src.sh`](../tools/sync-cli-src.sh).

The file is **input data** for [`../tools/extract-snippets`](../tools/extract-snippets), not a build target.
It deliberately does not belong to any crate — the extractor reads it as text,
walking the `// @doc-snippet:` / `// @doc-flag:` / `// @doc-test:` comment
markers to emit [`../js/snippets.generated.json`](../js/snippets.generated.json).

If your editor surfaces a rust-analyzer `unlinked-file` diagnostic on this
file, that is expected. Suppress it with:

```jsonc
// .vscode/settings.json (or your editor's equivalent)
"rust-analyzer.diagnostics.disabled": ["unlinked-file"]
```
