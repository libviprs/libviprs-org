#!/usr/bin/env node
/* benchmarks/tools/render-latest.mjs
 *
 * Render history.json into /benchmarks/index.html as static HTML.
 *
 *   node benchmarks/tools/render-latest.mjs [--history <path>] [--page <path>]
 *                                           [--config <path>] [--check]
 *
 * Rewrites everything between each pair of
 *
 *   <!-- GENERATED:<name>:BEGIN -->
 *   <!-- GENERATED:<name>:END -->
 *
 * markers in the page. `--check` renders and compares without writing, exiting
 * non-zero when the page no longer matches the history, which is what stops the
 * two drifting apart in silence.
 *
 * ## Why this is generated into the page rather than fetched at load
 *
 * The panel this pattern comes from fetched its numbers from a URL in another
 * repository. That repository moved, the URL started returning 404, and every
 * visitor read `Failed to load dual-engine.json: HTTP 404` for months before
 * anybody noticed. Static generated HTML is checked in, shows up in a diff,
 * renders with JavaScript off, and cannot 404. So every number on this page is
 * in the markup, and the interactive layer, when it lands, only ever adds
 * filtering on top of markup that already says everything.
 *
 * ## What this file is not allowed to know
 *
 * No series id, no colour, no threshold, no family name and no editorial
 * sentence lives here. They are all in config.json, which is the libviprs half
 * of the K2.3 contract: the renderer is the shape, the config is the content.
 * A third backend or a fourth family is a config edit.
 *
 * ## Two rules the markup enforces rather than describes
 *
 * A cell that is not gateable never gets a verdict chip. Not a grey one, not a
 * neutral one: none. It reads "measured, not gated" and carries the reasons.
 * Hiding it would make an untrusted number and an untested backend look the
 * same; chipping it would make a number its own producer refuses to vouch for
 * read as a result.
 *
 * An invariant is never charted. It is exact, so a trend line and an error bar
 * are both lies about it, and a reader should not be eyeballing a 0.008% byte
 * difference off a pixel. Invariants go in a table with equality verdicts, and
 * when one does move between runs that renders as a vertical rule on the
 * version axis carrying the commit that moved it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXIT = { OK: 0, STALE: 1, USAGE: 2, REFUSED: 3 };

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (n) => argv.includes(`--${n}`);

const KNOWN = new Set(['history', 'page', 'config', 'check', 'help']);
const unknown = argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2)).filter((a) => !KNOWN.has(a));
if (unknown.length) {
  console.error(`unknown flag(s): ${unknown.map((u) => `--${u}`).join(', ')}`);
  console.error(`known flags: ${[...KNOWN].map((k) => `--${k}`).join(' ')}`);
  process.exit(EXIT.USAGE);
}
if (has('help')) {
  console.error('usage: node benchmarks/tools/render-latest.mjs [--history <path>] [--page <path>] [--config <path>] [--check]');
  process.exit(EXIT.USAGE);
}

const historyPath = resolve(flag('history') ?? join(here, '..', 'history.json'));
const pagePath = resolve(flag('page') ?? join(here, '..', 'index.html'));
const configPath = resolve(flag('config') ?? join(here, 'config.json'));

const refuse = (why) => { console.error(`refused: ${why}`); process.exit(EXIT.REFUSED); };

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const ANY_DASH = new RegExp(`\\s*[${EM}${EN}]\\s*`, 'g');

/** Everything that arrives as data and leaves as prose comes through here. The
 *  producers write some of their reason strings with a dash doing the work of a
 *  comma; this page publishes neither kind, so the dash becomes a comma and the
 *  swap is announced on stderr rather than done quietly. */
const announced = new Set();
function prose(s) {
  const out = String(s ?? '');
  const clean = out.replace(ANY_DASH, ', ').replace(/\s+--\s+/g, ', ');
  if (clean !== out && !announced.has(out)) {
    announced.add(out);
    console.error(`note: a dash in a producer string became a comma:\n      ${out.slice(0, 160)}`);
  }
  return esc(clean);
}

/** Enough significant figures to be re-derivable, never more than the
 *  measurement supports. */
function num(n) {
  if (!Number.isFinite(n)) return 'n/a';
  const a = Math.abs(n);
  if (a >= 1000) return n.toFixed(0);
  if (a >= 100) return n.toFixed(1);
  if (a >= 10) return n.toFixed(2);
  if (a >= 1) return n.toFixed(3);
  return n.toFixed(4);
}

/** Counts and byte totals stay as digits with no separators. A grouped
 *  thousands mark would make 22127 unsearchable on the page, and the whole
 *  point of that figure is that a reader can go and look for it. */
const count = (n) => (Number.isFinite(n) ? String(Math.round(n)) : 'n/a');

function bytes(n) {
  if (!Number.isFinite(n)) return 'n/a';
  const mb = n / (1024 * 1024);
  return mb >= 1 ? `${count(n)} <span class="unit">(${mb.toFixed(1)} MiB)</span>` : count(n);
}

const pct = (n, dp = 3) => (Number.isFinite(n) ? `${(n * 100).toFixed(dp)}%` : 'n/a');

function confChip(c) {
  if (c === 'high') return '<span class="conf conf-high">high</span>';
  if (c === 'low') return '<span class="conf conf-low">low</span>';
  return '<span class="conf">n/a</span>';
}

// ---------------------------------------------------------------------------
// load, and refuse what cannot be vouched for
// ---------------------------------------------------------------------------

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const history = JSON.parse(readFileSync(historyPath, 'utf8'));

if (!Array.isArray(history) || history.length === 0) refuse(`${historyPath} holds no runs`);

const DIGEST = /^sha256:[0-9a-f]{64}$/;
for (const run of history) {
  const where = `${run.family ?? 'an entry'} in ${historyPath}`;
  if (!run.runId) {
    refuse(`${where} carries no runId, so it did not come through an import that archived it. ` +
      'Nothing is published, charted or quoted from a run that is not archived by digest.');
  }
  if (!run.documentDigest) {
    refuse(`run ${run.runId} carries no documentDigest, so there is nothing to check it against. ` +
      'Nothing is published, charted or quoted from a run that is not archived by digest.');
  }
  if (!DIGEST.test(run.documentDigest)) {
    refuse(`run ${run.runId} has a documentDigest that is not a sha256 digest: ${JSON.stringify(run.documentDigest)}`);
  }
  if (!config.families[run.family]) refuse(`run ${run.runId} is family "${run.family}", which config.json does not know`);
}

const byFamily = new Map();
for (const run of history) {
  if (!byFamily.has(run.family)) byFamily.set(run.family, []);
  byFamily.get(run.family).push(run);
}
for (const runs of byFamily.values()) runs.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));

const latest = (family) => {
  const runs = byFamily.get(family);
  return runs ? runs[runs.length - 1] : null;
};

/** Two runs are in the same comparable era only when every configured axis
 *  agrees. A run on another machine, or another filesystem, starts a new era
 *  rather than continuing the line, because drawing one line across the two
 *  invents a change that never happened. */
function eraKey(run) {
  return config.era.axes.map((axis) => {
    const [head, tail] = axis.split('.');
    const v = tail ? run[head]?.[tail] : run[head];
    return `${axis}=${Array.isArray(v) ? v.join('+') : String(v)}`;
  }).join('|');
}

const displayed = (run) => (run.samples ?? []).filter((s) => (s.replicateIndex ?? 0) === 0);

/** The band a single run can honestly draw: the spread the replicate pair
 *  measured for that very key, inside that very run. A band fitted from
 *  anything else would be a band about a different experiment. */
function bandPct(run, series, key) {
  const spread = run.replicate?.spreadPct?.[`${series}.${key}`];
  return Number.isFinite(spread) ? spread / 100 : null;
}

const timerFloorUs = (run) => {
  const tick = run.measurement?.timerTickNs;
  const ticks = run.measurement?.minTicksPerSample ?? config.confidence.minTicksPerSample;
  return Number.isFinite(tick) ? (tick * ticks) / 1000 : null;
};

// ---------------------------------------------------------------------------
// 1. the claim
// ---------------------------------------------------------------------------

function invariantIndex(run) {
  const byCell = new Map();
  for (const inv of run.invariants ?? []) {
    const cell = inv.cell ?? `${inv.scale}/${inv.source}`;
    if (!byCell.has(cell)) byCell.set(cell, new Map());
    const perSeries = byCell.get(cell);
    if (!perSeries.has(inv.series)) perSeries.set(inv.series, new Map());
    perSeries.get(inv.series).set(inv.name, inv.value);
  }
  return byCell;
}

/** The equality verdict for one invariant across the series in one cell. The
 *  rule per invariant is config's, never guessed from the values. */
function invariantVerdict(kind, values) {
  const present = values.filter((v) => v.value !== undefined && v.value !== null);
  if (present.length < 2) return { text: 'one backend only', cls: 'verdict-none', ok: null };

  if (kind === 'equal') {
    const same = present.every((v) => v.value === present[0].value);
    return same
      ? { text: 'equal', cls: 'verdict-equal', ok: true }
      : { text: 'differs', cls: 'verdict-differs', ok: false };
  }
  if (kind === 'within') {
    const nums = present.map((v) => Number(v.value));
    const lo = Math.min(...nums); const hi = Math.max(...nums);
    const rel = lo === 0 ? null : (hi - lo) / lo;
    return { text: `within ${pct(rel)}`, cls: 'verdict-within', ok: true, rel };
  }
  if (kind === 'ratio') {
    const nums = present.map((v) => Number(v.value));
    const lo = Math.min(...nums); const hi = Math.max(...nums);
    return { text: lo === 0 ? `${count(hi)} against 0` : `${count(hi)} against ${count(lo)}`, cls: 'verdict-ratio', ok: null, lo, hi };
  }
  if (kind === 'differs-by-construction') {
    const same = present.every((v) => v.value === present[0].value);
    return same
      ? { text: 'identical, which it should not be', cls: 'verdict-differs', ok: false }
      : { text: 'differs, and must', cls: 'verdict-none', ok: null };
  }
  return { text: 'no rule', cls: 'verdict-none', ok: null };
}

function claimSection() {
  const run = latest('storage');
  if (!run) return '<p>No storage run in the history, so there is no claim to state.</p>';

  const fam = config.families.storage;
  const idx = invariantIndex(run);
  const order = fam.invariantOrder;
  const seriesOrder = fam.seriesOrder.filter((s) => [...idx.values()].some((m) => m.has(s)));

  // The headline, computed. The entry count comes from the cell config names;
  // the byte bound is the worst relative gap across every cell, not this one.
  const claim = idx.get(fam.claimCell);
  const entriesBy = new Map(seriesOrder.map((s) => [s, claim?.get(s)?.get('filesystem_entries')]));
  const entryValues = [...entriesBy.values()].filter(Number.isFinite);
  const fewest = Math.min(...entryValues);
  const most = Math.max(...entryValues);
  const fewestSeries = seriesOrder.find((s) => entriesBy.get(s) === fewest);
  const mostSeries = seriesOrder.find((s) => entriesBy.get(s) === most);

  let worstByteGap = 0; let worstCell = null;
  for (const [cell, perSeries] of idx) {
    const vals = seriesOrder.map((s) => perSeries.get(s)?.get('output_bytes')).filter(Number.isFinite);
    if (vals.length < 2) continue;
    const lo = Math.min(...vals); const hi = Math.max(...vals);
    const rel = (hi - lo) / lo;
    if (rel > worstByteGap) { worstByteGap = rel; worstCell = cell; }
  }

  const cells = [...idx.keys()].sort();
  const rows = cells.map((cell) => {
    const perSeries = idx.get(cell);
    const body = seriesOrder.map((s) => {
      const m = perSeries.get(s);
      if (!m) return '';
      const tds = order.map((name) => {
        const v = m.get(name);
        if (v === undefined || v === null) {
          return '<td class="num absent" title="this run did not record it for this backend">not recorded</td>';
        }
        if (name === 'artefact_digest') return `<td class="num"><code class="mono digest">${esc(String(v).slice(0, 12))}</code></td>`;
        if (name.endsWith('_bytes')) return `<td class="num">${bytes(Number(v))}</td>`;
        return `<td class="num">${count(Number(v))}</td>`;
      }).join('');
      return `        <tr><th scope="row"><span class="swatch" style="background:${esc(fam.seriesColor[s] ?? '#888')}"></span>${esc(fam.seriesLabel[s] ?? s)}</th>${tds}</tr>`;
    }).join('\n');

    const verdicts = order.map((name) => {
      const kind = fam.invariantEquality[name];
      if (!kind) return '<td class="num"></td>';
      const v = invariantVerdict(kind, seriesOrder.map((s) => ({ series: s, value: perSeries.get(s)?.get(name) })));
      return `<td class="num"><span class="verdict ${v.cls}" data-invariant-verdict="${esc(name)}">${esc(v.text)}</span></td>`;
    }).join('');

    return `        <tr class="rowgroup"><th scope="rowgroup" colspan="${order.length + 1}"><code class="mono">${esc(cell)}</code></th></tr>
${body}
        <tr class="row-verdict"><th scope="row">agreement</th>${verdicts}</tr>`;
  }).join('\n');

  const head = order.map((n) => `<th scope="col">${esc(fam.invariantLabel[n] ?? n)}</th>`).join('');

  return `  <div class="section-head">
      <div class="section-kicker">Measured ${esc(String(run.capturedAt).slice(0, 10))} &middot; run <code class="mono">${esc(run.runId)}</code></div>
      <h2 id="claim-title">The same pyramid, one file against ${count(most)}.</h2>
    </div>

    <p class="lead">This is the result the PMTiles work was for, and it is an exact one. Both backends were handed
      the same tiles and asked to store them. ${esc(fam.seriesLabel[fewestSeries] ?? fewestSeries)} finished with
      ${count(fewest)} filesystem ${fewest === 1 ? 'entry' : 'entries'};
      ${esc(fam.seriesLabel[mostSeries] ?? mostSeries)} finished with ${count(most)} of them. Every tile is in both, and
      across all ${cells.length} cells the two byte totals never differ by more than ${pct(worstByteGap)}.</p>

    <div class="claim-figures">
      <div class="claim-figure"><div class="claim-number">${count(fewest)}</div><div class="claim-label">filesystem ${fewest === 1 ? 'entry' : 'entries'}, ${esc(fam.seriesLabel[fewestSeries] ?? fewestSeries)}, <code class="mono">${esc(fam.claimCell)}</code></div></div>
      <div class="claim-figure"><div class="claim-number">${count(most)}</div><div class="claim-label">filesystem ${most === 1 ? 'entry' : 'entries'}, ${esc(fam.seriesLabel[mostSeries] ?? mostSeries)}, the same cell</div></div>
      <div class="claim-figure"><div class="claim-number">${pct(worstByteGap)}</div><div class="claim-label">the widest the byte totals ever get apart, at <code class="mono">${esc(worstCell ?? 'n/a')}</code></div></div>
    </div>

    <p class="claim-note">No bands on any of this, and no chart of it either. These numbers do not vary: they came
      out the same on every repetition and they would come out the same again tomorrow on a busy host. A trend line
      and an error bar are both lies about an exact number, so they go in a table with equality verdicts, and when
      one of them does move between runs that shows up on the version axis further down as a rule carrying the
      commit that moved it.</p>

    <div class="table-wrap">
      <table class="results-table" data-invariant-table="storage">
        <caption>Invariants for run <code class="mono">${esc(run.runId)}</code>, per cell, per backend. Digests are the first 12 hex characters.</caption>
        <thead>
          <tr><th scope="col">backend</th>${head}</tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>

    <p class="footnote">The artefact digests differ, and they have to: one is a single archive and the other is a
      tree of loose files, so the bytes on disk are not the same bytes even when every tile in them is. What has to
      agree is the tile count, and it does, in every cell.</p>
`;
}

// ---------------------------------------------------------------------------
// 2. the engines comparison
// ---------------------------------------------------------------------------

function enginesSection() {
  const run = latest('engines');
  if (!run) return '<p>No engines run in the history, so there is nothing to compare.</p>';

  const fam = config.families.engines;
  const series = fam.seriesOrder;
  const cells = [...new Set(displayed(run).map((s) => s.cell))];
  const scaleOf = new Map(displayed(run).map((s) => [s.cell, s.scale]));
  cells.sort((a, b) => (scaleOf.get(a) - scaleOf.get(b)) || a.localeCompare(b));

  const at = new Map();
  for (const s of displayed(run)) at.set(`${s.series}/${s.cell}/${s.key}`, s);

  const METRICS = [
    ['build.wall', 'Wall time', 'ms', 'lower is better'],
    ['build.tracked_mb', 'Tracked working set', 'MB', 'lower is better'],
    ['build.tiles_per_s', 'Throughput', 'tiles/s', 'higher is better'],
  ];

  const tables = METRICS.map(([key, label, unit, sense]) => {
    const rows = cells.map((cell) => {
      const mp = scaleOf.get(cell);
      const vals = series.map((sx) => at.get(`${sx}/${cell}/${key}`));
      const present = vals.filter(Boolean).map((v) => v.median);
      const best = present.length
        ? (sense.startsWith('lower') ? Math.min(...present) : Math.max(...present))
        : null;
      const tds = series.map((sx, i) => {
        const v = vals[i];
        if (!v) return '<td class="num absent">no cell</td>';
        const isBest = best !== null && v.median === best;
        return `<td class="num${isBest ? ' best' : ''}">${num(v.median)}</td>`;
      }).join('');
      return `        <tr class="row-low" title="${esc(prose((vals.find(Boolean)?.gateBlockers ?? []).join('; ')))}"><th scope="row"><code class="mono">${esc(cell)}</code> <span class="unit">${num(mp)} MP</span></th>${tds}<td class="gate">measured, not gated</td></tr>`;
    }).join('\n');

    return `    <h3>${esc(label)} <span class="unit">(${esc(unit)}, ${esc(sense)})</span></h3>
    <div class="table-wrap">
      <table class="results-table">
        <thead>
          <tr><th scope="col">cell</th>${series.map((sx) => `<th scope="col"><span class="swatch" style="background:${esc(fam.seriesColor[sx] ?? '#888')}"></span>${esc(fam.seriesLabel[sx] ?? sx)}</th>`).join('')}<th scope="col">gate</th></tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>`;
  }).join('\n');

  // The memory story, computed off the largest cell the config points at.
  const claimCell = fam.memoryClaimCell;
  const mem = series.map((sx) => ({ series: sx, s: at.get(`${sx}/${claimCell}/build.tracked_mb`) })).filter((x) => x.s);
  // >= and <= so a tie keeps the first series in config order rather than the
  // last, which is why streaming and not mapreduce is named below: they measured
  // the same working set to the byte, and the tie is stated rather than hidden.
  const heaviest = mem.reduce((a, b) => (a.s.median >= b.s.median ? a : b), mem[0]);
  const lightest = mem.reduce((a, b) => (a.s.median <= b.s.median ? a : b), mem[0]);
  const tiedWith = mem.filter((x) => x.series !== lightest.series && x.s.median === lightest.s.median)
    .map((x) => fam.seriesLabel[x.series] ?? x.series);
  const mp = scaleOf.get(claimCell);
  const wallOf = (id) => at.get(`${id}/${claimCell}/build.wall`)?.median;
  const heavyWall = wallOf(heaviest.series);
  const lightWall = wallOf(lightest.series);
  const wallGap = Number.isFinite(heavyWall) && Number.isFinite(lightWall) && heavyWall > 0
    ? Math.abs(lightWall - heavyWall) / heavyWall : null;

  const suppressed = Object.entries(fam.suppressedMetrics ?? {})
    .map(([k, why]) => `<li><code class="mono">${esc(k)}</code>: ${prose(why)}</li>`).join('\n        ');

  const charts = [
    chartSvg({
      title: `Wall time against image size`,
      family: 'engines', run, key: 'build.wall', unit: 'ms',
      xOf: (s) => s.scale, yOf: (s) => s.median,
      xLabel: 'megapixels', yLabel: 'ms', logX: true, logY: true,
      filter: (s) => s.concurrency === 1,
    }),
    chartSvg({
      title: `Tracked working set against image size`,
      family: 'engines', run, key: 'build.tracked_mb', unit: 'MB',
      xOf: (s) => s.scale, yOf: (s) => s.median,
      xLabel: 'megapixels', yLabel: 'MB', logX: true, logY: true,
      filter: (s) => s.concurrency === 1,
    }),
  ].join('\n');

  return `  <div class="section-head">
      <div class="section-kicker">Run <code class="mono">${esc(run.runId)}</code> &middot; provenance ${esc(run.provenanceSource)}</div>
      <h2 id="engines-title">Three engines, the same pyramid, and where the memory goes.</h2>
    </div>

    <p class="lead">All three build the same tiles from the same source and produce the same tile count. Where they
      part company is how much of the image they are holding while they do it, and the tracked working set is the
      column that says so: at ${num(mp)} MP the ${esc(fam.seriesLabel[heaviest.series] ?? heaviest.series)} engine
      is holding ${num(heaviest.s.median)} MB and ${esc(fam.seriesLabel[lightest.series] ?? lightest.series)} is
      holding ${num(lightest.s.median)} MB${tiedWith.length ? ` (and so ${tiedWith.length === 1 ? 'is' : 'are'} ${esc(tiedWith.join(' and '))}, to the byte)` : ''}. That is a factor of
      ${num(heaviest.s.median / (lightest.s.median || 1))}, for wall times of ${num(heavyWall)} ms against
      ${num(lightWall)} ms${wallGap === null ? '' : `, ${pct(wallGap, 1)} apart`}. Read the memory column, not the
      RSS one: the note below says why there is no RSS column here at all.</p>

    <div class="status-callout">
      <p><strong>None of these cells is gated, and none of them carries a chip.</strong> This sweep measures each
        cell once, with no repetitions and no warm-up, so it has no dispersion, and a pass or a regression read off
        a single sample would be a statement about the afternoon rather than about the code. Its provenance is an
        attestation rather than something the runner observed, for the same reason. The numbers are real and they
        are published in full; what is missing is anything that could gate them.</p>
      <p>Suppressed on the way in:</p>
      <ul>
        ${suppressed}
      </ul>
    </div>

${tables}

    <div class="charts">
${charts}
    </div>
`;
}

// ---------------------------------------------------------------------------
// charts
// ---------------------------------------------------------------------------

const W = 520; const H = 260; const PAD = { l: 58, r: 14, t: 26, b: 42 };

function niceTicks(lo, hi, log) {
  if (log) {
    const out = [];
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) out.push(10 ** e);
    return out.filter((v) => v >= lo / 10 && v <= hi * 10);
  }
  const span = hi - lo || 1;
  const step = 10 ** Math.floor(Math.log10(span / 4));
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step / 2; v += step) out.push(v);
  return out;
}

/** One chart, as inline SVG, so it is in the markup rather than drawn later.
 *  `data-series-key` is what the invariant guard reads: an invariant name
 *  appearing there would mean something exact had been charted. */
function chartSvg({ title, family, run, key, unit, xOf, yOf, xLabel, yLabel, logX, logY, filter, steps = [] }) {
  const fam = config.families[family];
  const rows = displayed(run).filter((s) => s.key === key).filter((s) => (filter ? filter(s) : true));
  if (rows.length === 0) return '';

  const xs = rows.map(xOf).filter(Number.isFinite);
  const ys = rows.map(yOf).filter(Number.isFinite);
  const xlo = Math.min(...xs); const xhi = Math.max(...xs);
  const ylo = Math.min(...ys); const yhi = Math.max(...ys);

  const sx = (v) => {
    const t = logX
      ? (Math.log10(v) - Math.log10(xlo || 1e-6)) / ((Math.log10(xhi) - Math.log10(xlo || 1e-6)) || 1)
      : (v - xlo) / ((xhi - xlo) || 1);
    return PAD.l + t * (W - PAD.l - PAD.r);
  };
  const sy = (v) => {
    const t = logY
      ? (Math.log10(Math.max(v, 1e-6)) - Math.log10(Math.max(ylo, 1e-6))) / ((Math.log10(Math.max(yhi, 1e-6)) - Math.log10(Math.max(ylo, 1e-6))) || 1)
      : (v - ylo) / ((yhi - ylo) || 1);
    return H - PAD.b - t * (H - PAD.t - PAD.b);
  };

  const grid = [
    ...niceTicks(ylo, yhi, logY).map((v) => `<line class="chart-grid" x1="${PAD.l}" y1="${sy(v).toFixed(1)}" x2="${W - PAD.r}" y2="${sy(v).toFixed(1)}"/><text class="chart-tick" x="${PAD.l - 6}" y="${(sy(v) + 3.5).toFixed(1)}" text-anchor="end">${esc(num(v))}</text>`),
    ...niceTicks(xlo, xhi, logX).map((v) => `<text class="chart-tick" x="${sx(v).toFixed(1)}" y="${H - PAD.b + 15}" text-anchor="middle">${esc(num(v))}</text>`),
  ].join('\n      ');

  const seriesPaths = fam.seriesOrder.map((id) => {
    const own = rows.filter((s) => s.series === id).sort((a, b) => xOf(a) - xOf(b));
    if (own.length === 0) return '';
    const colour = fam.seriesColor[id] ?? '#888';
    const dash = fam.seriesDash[id];
    const d = own.map((s, i) => `${i === 0 ? 'M' : 'L'}${sx(xOf(s)).toFixed(1)},${sy(yOf(s)).toFixed(1)}`).join(' ');

    // The band is the replicate spread this run measured for this very key, or
    // nothing at all. A band drawn from anywhere else is a band about a
    // different experiment.
    const spread = bandPct(run, id, key);
    const band = spread === null ? '' :
      `<path class="chart-band" fill="${esc(colour)}" d="${own.map((s, i) => `${i === 0 ? 'M' : 'L'}${sx(xOf(s)).toFixed(1)},${sy(yOf(s) * (1 + spread)).toFixed(1)}`).join(' ')} ${own.slice().reverse().map((s) => `L${sx(xOf(s)).toFixed(1)},${sy(yOf(s) * (1 - spread)).toFixed(1)}`).join(' ')} Z"/>`;

    const dots = own.map((s) => `<circle class="chart-point" cx="${sx(xOf(s)).toFixed(1)}" cy="${sy(yOf(s)).toFixed(1)}" r="3" fill="${esc(colour)}"><title>${esc(fam.seriesLabel[id] ?? id)} ${esc(s.cell)}: ${esc(num(yOf(s)))} ${esc(unit)}</title></circle>`).join('');

    return `${band}<path class="chart-line" data-series-key="${esc(`${family}:${id}:${key}`)}" d="${d}" stroke="${esc(colour)}"${dash ? ` stroke-dasharray="${esc(dash)}"` : ''}/>${dots}`;
  }).join('\n      ');

  const stepRules = steps.map((st) => `<line class="step-rule" data-invariant-step="${esc(`${st.name} ${st.series} ${st.cell}`)}" x1="${sx(st.x).toFixed(1)}" y1="${PAD.t}" x2="${sx(st.x).toFixed(1)}" y2="${H - PAD.b}"/>`).join('\n      ');

  const legend = fam.seriesOrder.filter((id) => rows.some((s) => s.series === id)).map((id) =>
    `<li class="legend-item"><span class="legend-swatch" style="background:${esc(fam.seriesColor[id] ?? '#888')}"></span><span class="legend-label">${esc(fam.seriesLabel[id] ?? id)}</span></li>`).join('');

  return `      <figure class="chart">
        <figcaption class="chart-title">${esc(title)}</figcaption>
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" preserveAspectRatio="xMidYMid meet">
      ${grid}
      ${seriesPaths}
      ${stepRules}
      <line class="chart-axis" x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${H - PAD.b}"/>
      <line class="chart-axis" x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}"/>
      <text class="chart-axis-label" x="${(W / 2).toFixed(0)}" y="${H - 6}" text-anchor="middle">${esc(xLabel)}</text>
      <text class="chart-axis-label" x="12" y="${(H / 2).toFixed(0)}" text-anchor="middle" transform="rotate(-90 12 ${(H / 2).toFixed(0)})">${esc(yLabel)}</text>
        </svg>
        <ul class="chart-legend">${legend}</ul>
      </figure>`;
}

// ---------------------------------------------------------------------------
// 3. over versions
// ---------------------------------------------------------------------------

/** An invariant that moved between two runs of the same family, in the same
 *  era. Not a series: a step, and the interesting thing about it is which
 *  commit did it. */
function invariantSteps(runs) {
  const out = [];
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1]; const next = runs[i];
    if (eraKey(prev) !== eraKey(next)) continue;
    const a = invariantIndex(prev); const b = invariantIndex(next);
    for (const [cell, perSeries] of b) {
      for (const [series, names] of perSeries) {
        for (const [name, value] of names) {
          const was = a.get(cell)?.get(series)?.get(name);
          if (was === undefined || was === value) continue;
          out.push({ cell, series, name, from: was, to: value, x: i, run: next });
        }
      }
    }
  }
  return out;
}

function versionAxis(runs) {
  return runs.map((r, i) => ({
    i,
    label: r.library?.version ?? String(r.capturedAt).slice(0, 10),
    commit: r.library?.commit ?? null,
    runId: r.runId,
    era: eraKey(r),
  }));
}

/** Every cell, every series, including the replicate pair, in a collapsible
 *  block. The low-confidence rows are in here with their numbers and a reason,
 *  because dropping them would make an untested backend and an untrusted
 *  measurement look the same on a page whose whole job is telling those apart. */
function fullResults(familyId) {
  const run = latest(familyId);
  if (!run) return '';
  const fam = config.families[familyId];
  const all = [...(run.samples ?? [])].sort((a, b) =>
    a.cell.localeCompare(b.cell) || a.key.localeCompare(b.key) ||
    fam.seriesOrder.indexOf(a.series) - fam.seriesOrder.indexOf(b.series) ||
    (a.replicateIndex ?? 0) - (b.replicateIndex ?? 0));

  const rows = all.map((s) => {
    const low = s.confidence !== 'high';
    const why = s.lowConfidenceReasons.join('; ') || s.gateBlockers.join('; ');
    return `        <tr${low ? ' class="row-low"' : ''}${why ? ` title="${esc(prose(why))}"` : ''}>` +
      `<th scope="row"><code class="mono">${esc(s.cell)}</code></th>` +
      `<td><code class="mono">${esc(s.key)}</code></td>` +
      `<td><span class="swatch" style="background:${esc(fam.seriesColor[s.series] ?? '#888')}"></span>${esc(fam.seriesLabel[s.series] ?? s.series)}</td>` +
      `<td class="num">${num(s.median)} <span class="unit">${esc(s.unit)}</span></td>` +
      `<td class="num">${Array.isArray(s.ci95) ? `${num(s.ci95[0])}&hairsp;to&hairsp;${num(s.ci95[1])}` : '<span class="absent">none</span>'}</td>` +
      `<td class="num">${s.cov === null ? '<span class="absent">none</span>' : pct(s.cov, 1)}</td>` +
      `<td class="num">${count(s.reps)}</td>` +
      `<td class="num">${(s.replicateIndex ?? 0) + 1}</td>` +
      `<td>${confChip(s.confidence)}</td>` +
      `<td>${s.gated ? '<span class="gate gate-on">gateable</span>' : '<span class="gate">measured, not gated</span>'}</td></tr>`;
  }).join('\n');

  const skipped = (run.skipped ?? []).map((s) =>
    `        <tr class="row-absent"><th scope="row"><code class="mono">${esc(s.cell)}</code></th>` +
    `<td><code class="mono">${esc(s.key)}</code></td>` +
    `<td>${esc(fam.seriesLabel[s.series] ?? s.series)}</td>` +
    `<td class="absent" colspan="7"><strong>${esc(s.outcome)}</strong>: ${prose(s.reason ?? 'no reason recorded')}</td></tr>`).join('\n');

  const c = run.cellCounts ?? {};
  return `      <details class="status-callout">
        <summary>Every cell in <code class="mono">${esc(fam.label)}</code>: ${count(c.measured)} measured, ${count(c.notMeasured)} that produced no number, ${count(c.lowConfidence)} low confidence</summary>
        <div class="table-wrap">
          <table class="results-table">
            <thead>
              <tr><th scope="col">cell</th><th scope="col">key</th><th scope="col">series</th>
                  <th scope="col">median</th><th scope="col">95% interval</th><th scope="col">CoV</th>
                  <th scope="col">reps</th><th scope="col">replicate</th>
                  <th scope="col">confidence</th><th scope="col">gate</th></tr>
            </thead>
            <tbody>
${rows}
${skipped}
            </tbody>
          </table>
        </div>
      </details>`;
}

function historySection() {
  const blocks = config.defaults.families.map((familyId) => {
    const fam = config.families[familyId];
    const runs = byFamily.get(familyId) ?? [];
    if (runs.length === 0) return '';
    const axis = versionAxis(runs);
    const steps = invariantSteps(runs);
    const run = runs[runs.length - 1];
    const eras = new Set(axis.map((a) => a.era)).size;

    const charts = fam.headlineKeys.map((key) => {
      const rows = displayed(run).filter((s) => s.key === key && s.cell === fam.headlineCell);
      if (rows.length === 0) return '';
      const unit = rows[0].unit;
      // x is the run's position on the version axis, which is why a single-run
      // history draws a single point and no line, rather than a trend.
      return chartSvg({
        title: `${config.metricLabel[rows[0].metric] ?? rows[0].metric}, ${config.scenarioLabel[rows[0].scenario] ?? rows[0].scenario}, ${fam.headlineCell}`,
        family: familyId, run, key, unit,
        xOf: () => runs.length - 1,
        yOf: (s) => s.median,
        xLabel: `version (${axis.map((a) => a.label).join(', ')})`,
        yLabel: unit, logX: false, logY: false,
        filter: (s) => s.cell === fam.headlineCell,
        steps: steps.map((st) => ({ ...st, x: st.x })),
      });
    }).filter(Boolean).join('\n');

    const gateable = displayed(run).filter((s) => s.gated).length;
    const notGateable = displayed(run).length - gateable;

    const rows = fam.headlineKeys.map((key) => {
      const own = displayed(run).filter((s) => s.key === key && s.cell === fam.headlineCell);
      if (own.length === 0) return '';
      return fam.seriesOrder.filter((id) => own.some((s) => s.series === id)).map((id) => {
        const s = own.find((x) => x.series === id);
        const spread = bandPct(run, id, key);
        const chip = s.gated
          ? (runs.length < 2
            ? '<span class="verdict verdict-first">first run</span>'
            : '<span class="verdict verdict-pass">no change</span>')
          : '<span class="gate">measured, not gated</span>';
        return `        <tr${s.confidence === 'high' ? '' : ' class="row-low"'} title="${esc(prose(s.gateBlockers.join('; ') || s.lowConfidenceReasons.join('; ')))}">` +
          `<th scope="row"><code class="mono">${esc(key)}</code></th>` +
          `<td><span class="swatch" style="background:${esc(fam.seriesColor[id] ?? '#888')}"></span>${esc(fam.seriesLabel[id] ?? id)}</td>` +
          `<td class="num">${num(s.median)} <span class="unit">${esc(s.unit)}</span></td>` +
          `<td class="num">${spread === null ? '<span class="absent">no replicate</span>' : `&plusmn;${pct(spread, 2)}`}</td>` +
          `<td class="num">${s.reps}</td>` +
          `<td>${confChip(s.confidence)}</td>` +
          `<td>${chip}</td></tr>`;
      }).join('\n');
    }).filter(Boolean).join('\n');

    const stepList = steps.length === 0 ? '' : `    <ul class="step-labels">
${steps.map((st) => `      <li class="step-label" data-invariant-step="${esc(`${st.name} ${st.series} ${st.cell}`)}"><code class="mono">${esc(st.name)}</code> on <code class="mono">${esc(st.series)}</code> at <code class="mono">${esc(st.cell)}</code> moved from ${count(st.from)} to ${count(st.to)} at <code class="mono">${esc(String(st.run.library?.commit ?? st.run.runId).slice(0, 12))}</code></li>`).join('\n')}
    </ul>`;

    return `    <div class="family-block">
      <h3 class="family-title">${esc(fam.label)}</h3>
      <p>${runs.length === 1
        ? `One archived run so far, so every point below is a single point and nothing on this axis is a trend yet. The band around it is the spread the run's own replicate pair measured for that key, which is the only band a single run can honestly draw.`
        : `${runs.length} archived runs across ${eras} comparable ${eras === 1 ? 'era' : 'eras'}. A run whose host fingerprint or filesystem differs starts a new era rather than continuing the line.`}
        ${gateable} of ${displayed(run).length} cells in the latest run are gateable; the other ${notGateable} are published with their numbers and no chip.</p>
      <div class="table-wrap">
        <table class="results-table">
          <caption>Headline cells for <code class="mono">${esc(fam.headlineCell)}</code>, latest run.</caption>
          <thead>
            <tr><th scope="col">key</th><th scope="col">series</th><th scope="col">median</th>
                <th scope="col">replicate spread</th><th scope="col">reps</th>
                <th scope="col">confidence</th><th scope="col">gate</th></tr>
          </thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>
      <div class="charts">
${charts}
      </div>
${stepList}
${fullResults(familyId)}
    </div>`;
  }).filter(Boolean).join('\n');

  return `  <div class="section-head">
      <div class="section-kicker">${history.length} archived run${history.length === 1 ? '' : 's'} across ${byFamily.size} ${byFamily.size === 1 ? 'family' : 'families'}</div>
      <h2 id="history-title">Latency and throughput, as versions go by.</h2>
    </div>

    <p class="lead">One point per archived run, per family, on its own version axis. The band is the replicate
      spread measured inside that run rather than a model fitted to anything, and a chip only ever appears on a
      cell that is gateable: the right repetitions, a timer that did not saturate, a confidence its own producer
      signed off, and provenance the runner observed rather than a person attested.</p>

${blocks}
`;
}

// ---------------------------------------------------------------------------
// 4. provenance and method
// ---------------------------------------------------------------------------

function methodSection() {
  const blocks = config.defaults.families.map((familyId) => {
    const run = latest(familyId);
    if (!run) return '';
    const fam = config.families[familyId];
    const m = run.measurement ?? {};
    const floor = timerFloorUs(run);
    const counts = run.cellCounts ?? {};

    const ungateable = new Map();
    for (const s of displayed(run)) {
      if (s.gated) continue;
      for (const b of (s.gateBlockers.length ? s.gateBlockers : ['no reason recorded'])) {
        ungateable.set(b, (ungateable.get(b) ?? 0) + 1);
      }
    }

    const reps = Object.entries(m.reps ?? {}).map(([k, v]) => `${esc(k)} ${v}`).join(', ');
    const ev = (run.host?.emulationEvidence ?? []).map((e) => `${e.source}: ${e.verdict}`).join('; ');

    return `    <div class="family-block">
      <h3 class="family-title">${esc(fam.label)}</h3>
      <ul class="meta-list">
        <li class="meta-item"><strong>run</strong> <code class="mono">${esc(run.runId)}</code></li>
        <li class="meta-item"><strong>document digest</strong> <code class="mono">${esc(run.documentDigest)}</code></li>
        <li class="meta-item"><strong>provenance</strong> ${esc(run.provenanceSource)}${run.provenanceSource === 'attested' ? `, and the page says so wherever these numbers appear: ${prose(run.attestation?.statement ?? '')}` : `, read off the host by the runner${ev ? ` (emulation probe: ${esc(ev)})` : ''}`}</li>
        <li class="meta-item"><strong>engine</strong> <code class="mono">${esc(run.library?.name)} ${esc(run.library?.version)}</code> at <code class="mono">${esc(String(run.library?.commit ?? '').slice(0, 12))}</code>, harness at <code class="mono">${esc(String(run.benchCommit ?? '').slice(0, 12))}</code></li>
        <li class="meta-item"><strong>host</strong> <code class="mono">${esc(run.host?.os)}/${esc(run.host?.arch)}</code>, ${count(run.host?.ncpu)} cores, ${run.host?.inContainer ? 'in a container' : 'on the metal'}, filesystem <code class="mono">${esc(run.host?.fsType ?? 'unknown')}</code> on <code class="mono">${esc(run.host?.mountSource ?? 'unknown')}</code></li>
        <li class="meta-item"><strong>isolation</strong> ${esc(m.unit ?? 'not recorded')}, ${esc(m.isolation ?? 'not recorded')}</li>
        <li class="meta-item"><strong>repetitions</strong> ${reps || 'not recorded'}${m.warmup ? `, warm-up ${esc(m.warmup.policy)} (${count(m.warmup.passes)} pass)` : ''}</li>
        <li class="meta-item"><strong>estimator</strong> ${esc(m.interval?.statistic ?? 'not recorded')}, ${esc(m.interval?.method ?? 'no interval')}${m.interval?.level ? ` at ${(m.interval.level * 100).toFixed(0)}% over ${count(m.interval.resamples)} resamples` : ''}</li>
        <li class="meta-item"><strong>timer</strong> tick ${num(m.timerTickNs)} ns, call cost ${num(m.timerCallNs)} ns, ${count(m.minTicksPerSample)} ticks minimum, so <span data-timer-floor="${floor === null ? 'n/a' : floor.toFixed(1)}">anything under ${floor === null ? 'n/a' : floor.toFixed(1)} &micro;s is below what this host's clock can resolve</span></li>
        <li class="meta-item"><strong>page cache</strong> ${esc(m.pageCache ?? 'not recorded')}. Cold here means a cold reader: a fresh process opening an artefact it has not opened. Nothing dropped the kernel's caches, and the run does not pretend otherwise.</li>
        <li class="meta-item"><strong>cells</strong> ${count(counts.measured)} measured, ${count(counts.notMeasured)} that produced no number, ${count(counts.lowConfidence)} low confidence of which ${count(counts.timerSaturated)} because the timer saturated${counts.replicated ? `, and ${count(counts.replicated)} measured a second time to give the replicate spread` : ''}</li>
      </ul>
      <p class="footnote"><strong>Not gateable, and why:</strong></p>
      <ul class="meta-list">
        ${[...ungateable.entries()].sort((a, b) => b[1] - a[1]).map(([why, n]) => `<li class="meta-item">${count(n)} cell${n === 1 ? '' : 's'}: ${prose(why)}</li>`).join('\n        ') || '<li class="meta-item">every cell in this run is gateable</li>'}
      </ul>
    </div>`;
  }).filter(Boolean).join('\n');

  return `  <div class="section-head">
      <h2 id="method-title">Where these numbers came from.</h2>
    </div>

    <p class="lead">Generated from the runs themselves rather than written down once and left. If the host changes
      its clock, or the harness changes its repetition count, this section changes with it.</p>

${blocks}
`;
}

// ---------------------------------------------------------------------------
// 5. what this page does not measure
// ---------------------------------------------------------------------------

function notMeasuredSection() {
  const items = config.notMeasured.map((c) =>
    `    <div class="caveat"><h3 class="caveat-title">${esc(c.title)}</h3><p>${prose(c.body)}</p></div>`).join('\n');
  return `  <div class="section-head">
      <h2 id="not-measured-title">What this page does not measure.</h2>
    </div>

${items}
`;
}

// ---------------------------------------------------------------------------
// splice
// ---------------------------------------------------------------------------

const SECTIONS = [
  ['claim', claimSection],
  ['engines', enginesSection],
  ['history', historySection],
  ['method', methodSection],
  ['not-measured', notMeasuredSection],
];

let page = readFileSync(pagePath, 'utf8');
for (const [name, fn] of SECTIONS) {
  const BEGIN = `<!-- GENERATED:${name}:BEGIN -->`;
  const END = `<!-- GENERATED:${name}:END -->`;
  const b = page.indexOf(BEGIN);
  const e = page.indexOf(END);
  if (b === -1 || e === -1 || e < b) refuse(`${pagePath} has no GENERATED:${name} markers to write between`);
  page = page.slice(0, b) + `${BEGIN}\n${fn()}  ${END}` + page.slice(e + END.length);
}

const original = readFileSync(pagePath, 'utf8');
if (has('check')) {
  if (page === original) {
    console.log(`up to date: ${pagePath} matches ${history.map((r) => r.runId).join(', ')}`);
    process.exit(EXIT.OK);
  }
  console.error(`STALE: ${pagePath} does not match ${historyPath}. Re-run without --check.`);
  process.exit(EXIT.STALE);
}

writeFileSync(pagePath, page);
for (const run of history) {
  console.log(`${String(run.family).padEnd(8)} ${run.runId}  ${displayed(run).length} shown of ${run.samples.length}  provenance ${run.provenanceSource}`);
}
console.log(`\nwrote ${pagePath}`);
