# `benchmarks/vendor/` — the interactive dashboard, frozen

Three files copied byte for byte from `libviprs-bench`. **Nothing here is this
repository's to edit.** A hand edit here is the divergence the whole
frozen-vendoring arrangement exists to prevent, and `check-vendor.mjs` turns
that from a convention into a red build.

| file | copied from `libviprs-bench` |
| --- | --- |
| `dashboard.js` | `tools/contract/generated/dashboard.js` |
| `dashboard.css` | `tools/contract/upstream/dashboard.css` |
| `dashboard-config.json` | `tools/contract/config.json` |

`dashboard.js` is the **parameterised** build, not the frozen upstream one:
libviprs-bench keeps causl's original at `tools/contract/upstream/dashboard.js`
untouched and proves the parameterised one renders identically to it under an
absent config, which is what makes "we changed only what the config says" a
checkable claim rather than an assertion.

`dashboard.css` is the upstream file as-is. It defines 35 of the 39 classes the
dashboard emits; `benchmarks/css/benchmarks-dashboard.css` defines none of them,
because that stylesheet dresses the generated static page and the two class
vocabularies are disjoint. They do not collide.

## Checking it against the pin

`node benchmarks/tools/check-vendor.mjs` catches a hand edit. `--bench <checkout>`
also asks libviprs-bench what each file's blob is at `BENCH_REV` and refuses on a
difference, which is what stops this vendoring a head nobody pinned. CI runs it in
`benchmark-ingest.yml` beside `ingest.mjs --check`.

## What it needs from this site

The stylesheet reads causl's brand tokens, which this site does not define, so
`css/dashboard-bridge.css` maps them onto this site's two themes and picks readable
series and verdict colours per theme. It restyles no class. The specs in `e2e/`
measure the result in both themes.

## Taking a newer revision

Re-copy all three from a libviprs-bench checkout, then rewrite the manifest:

```
node benchmarks/tools/check-vendor.mjs --write
```

Review the diff. If `dashboard.js` changed, the change came from
libviprs-bench's config or from causl upstream, and the reason is in that
repository's history rather than in this one.
