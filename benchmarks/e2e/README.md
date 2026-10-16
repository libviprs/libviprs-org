# Playwright specs for /benchmarks/

These drive the generated benchmarks page in a real browser. Specs are named with
the issue they reproduce (`benchmarks-91-...`), so the report and the
reproduction stay findable from each other.

They read the committed page and change nothing. Run them in a node 22 container,
not on a laptop:

```
cd benchmarks/e2e
npm ci
npx playwright install --with-deps chromium   # or use a Playwright image with node 22 on top
npx playwright test
```

`serve.mjs` is the whole server: the repository root on 127.0.0.1:4173, no
dependencies. `contrast.mjs` is the WCAG arithmetic the contrast specs share, so
every ratio they print is computed one way.

The `--bc-muted` test is an expected failure on purpose. The token belongs to the
renderer the pinned libviprs-bench revision uses, and `ingest.mjs --check` refuses
any chart that differs from what that renderer draws, so the fix has to land
upstream. Playwright turns the annotation red the day it does.
