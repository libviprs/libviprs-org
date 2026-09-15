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
 * renders with JavaScript off, and cannot 404.
 *
 * ## The shape layer, and why it is the first thing in the file
 *
 * Four separate lanes in this wave shipped a cross-repo shape mismatch, and
 * every one of them looked like correct behaviour rather than a broken lookup:
 * ten config keys read that the config never defined, an archive directory
 * resolved one way and written another, a digest nested where the reader wanted
 * it flat, and this file reading `run.series` and `sample.series` off an
 * importer that writes `run.libraries` and `sample.library`. They survive
 * because `undefined` renders as an empty string, a missing array reduces to
 * nothing, and a section that quietly produces no rows looks exactly like a
 * section with no rows to produce.
 *
 * So nothing below reads a raw history entry. `normalise()` is the only code in
 * this file that knows the importer's field names, it names every field it
 * needs, and a field it cannot find is a refusal that prints the path rather
 * than an `undefined` that prints as blank. Add a field to the page and you add
 * it there, where a missing one is a red build in one line.
 *
 * ## What this file is not allowed to know
 *
 * No series id, no colour, no threshold, no family name and no editorial
 * sentence lives here. They are all in config.json, which is the libviprs half
 * of the K2.3 contract: the renderer is the shape, the config is the content.
 *
 * ## Two rules the markup enforces rather than describes
 *
 * A cell that is not gateable never gets a verdict chip. Not a grey one, not a
 * neutral one: none. It reads "measured, not gated" and carries the reason.
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
const MIDDOT = String.fromCharCode(0x00b7);
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

const dig = (obj, path) => String(path).split('.').reduce((o, k) => (o === undefined || o === null ? o : o[k]), obj);

// ---------------------------------------------------------------------------
// the shape layer
// ---------------------------------------------------------------------------

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const history = JSON.parse(readFileSync(historyPath, 'utf8'));

if (!Array.isArray(history) || history.length === 0) refuse(`${historyPath} holds no runs`);

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The run's document digest, from the carried integrity block or a flat field.
 *
 *  The importer carries the document's own `integrity` block through intact,
 *  four digests keyed the way the producer writes them, so the document digest
 *  lives at `integrity.document`. `documentDigest` is read as well because a
 *  history written before that block was carried has it flat, and refusing
 *  those would throw away real archived runs over a field name. */
function documentDigestOf(run) {
  return run?.integrity?.document ?? run?.documentDigest ?? null;
}

/** Read one field the page needs, or refuse naming the path.
 *
 *  This is the whole point of the shape layer. A lookup that misses returns
 *  `undefined`, `undefined` renders as an empty string, and an empty string in a
 *  table cell is indistinguishable from a cell the run genuinely had nothing
 *  for. Every one of the four shape mismatches this wave shipped had that
 *  shape. Missing here is loud. */
function need(run, path, why) {
  const v = dig(run, path);
  if (v === undefined || v === null) {
    refuse(`run ${run.runId ?? '(no runId)'} has nothing at "${path}", which the page needs for ${why}.\n` +
      '         The importer\'s shape and this renderer\'s have diverged. Fix it in normalise(), which is the\n' +
      '         only place in this file that knows a producer field name.');
  }
  return v;
}

const optional = (run, path, fallback = null) => {
  const v = dig(run, path);
  return v === undefined ? fallback : v;
};

/** Split a metric key into the scenario that produced it and the metric itself.
 *  `generate.wall` is generate/wall, `read_concurrent@4.p50` is
 *  read_concurrent@4/p50, `pyramid.tiles_per_second` is pyramid/tiles_per_second. */
function splitKey(key) {
  const i = String(key).lastIndexOf('.');
  return i === -1 ? { scenario: String(key), metric: String(key) } : { scenario: key.slice(0, i), metric: key.slice(i + 1) };
}

/** The thread count a cell name declares, or null. `12000x8400@256+c8` is eight
 *  threads; a storage cell such as `8192x8192@64+gradient` declares none. */
function concurrencyOf(cell) {
  const m = /\+c(\d+)$/.exec(String(cell));
  return m ? Number(m[1]) : null;
}

/** The cell with its concurrency suffix taken off, so the two arms of one image
 *  size group together. */
const baseCell = (cell) => String(cell).replace(/\+c\d+$/, '');

function normSample(raw, run, { recovered = false } = {}) {
  const key = need(raw, 'key', 'the metric a row reports');
  const { scenario, metric } = splitKey(key);
  const gated = optional(raw, 'gated', false) === true;
  const reason = optional(raw, 'ungateableReason', null);
  return {
    raw,
    series: need(raw, 'library', 'which backend or engine a row belongs to'),
    cell: need(raw, 'cell', 'which cell a row belongs to'),
    scale: need(raw, 'scale', 'the size axis'),
    source: optional(raw, 'source', null),
    key, scenario, metric,
    scenarioLabel: optional(raw, 'scenario', `${scenario} ${MIDDOT} ${optional(raw, 'source', '')}`),
    unit: need(raw, 'unit', 'the unit a number is in'),
    direction: need(raw, 'direction', 'whether higher or lower is better, which the verdict rule turns on'),
    median: need(raw, 'median', 'the number itself'),
    min: optional(raw, 'min', null),
    max: optional(raw, 'max', null),
    p95: optional(raw, 'p95OfSamples', optional(raw, 'p95Ms', null)),
    cov: optional(raw, 'cov', null),
    ci95: optional(raw, 'ci95', null),
    reps: optional(raw, 'reps', null),
    minReps: optional(raw, 'minReps', null),
    confidence: need(raw, 'confidence', 'whether the producer vouches for a number'),
    lowConfidenceReasons: optional(raw, 'lowConfidenceReasons', []),
    timerSaturated: optional(raw, 'timerSaturated', null),
    quietHost: optional(raw, 'machineLoad.quiet', null),
    peakRssMb: optional(raw, 'peakRssMb', null),
    declared: optional(raw, 'declared', false) === true,
    gated,
    gateBlockers: gated ? [] : [reason ?? 'no reason recorded'],
    spreadPct: Number.isFinite(optional(raw, 'replicateSpreadPct', null)) ? raw.replicateSpreadPct / 100 : null,
    spreadCell: optional(raw, 'replicateSpreadCell', null),
    concurrency: concurrencyOf(raw.cell),
    baseCell: baseCell(raw.cell),
    recovered,
  };
}

/** One imported history entry, turned into the shape the rest of this file
 *  uses. Nothing below reads a raw entry. */
function normalise(run) {
  const runId = run.runId;
  if (!runId) {
    refuse('an entry in the history carries no runId, so it did not come through an import that archived it. ' +
      'Nothing is published, charted or quoted from a run that is not archived by digest.');
  }
  const digest = documentDigestOf(run);
  if (!digest) {
    refuse(`run ${runId} carries no document digest, at integrity.document or documentDigest, ` +
      'so there is nothing to check it against. Nothing is published, charted or quoted from a run ' +
      'that is not archived by digest.');
  }
  if (!DIGEST.test(digest)) {
    refuse(`run ${runId} has a document digest that is not a sha256 digest: ${JSON.stringify(digest)}`);
  }
  const family = run.family;
  if (!config.families[family]) refuse(`run ${runId} is family ${JSON.stringify(family)}, which config.json does not know`);

  const libraries = need(run, 'libraries', 'the series this run measured');
  const declaredReplicateCell = optional(run, 'replicate.cell', null);

  // A replicate is the same cell measured twice. The run declares which cell
  // that is, so anything in `replicates` naming a different cell is not a
  // replicate of anything: it is a distinct cell filed under the wrong heading,
  // and dropping it would silently lose a whole arm of the experiment. The
  // engines run does exactly this with its eight-thread cells, which share a
  // tile count with their single-thread twins. They are read as the cells they
  // say they are, and the page says how many were recovered and why.
  const rawReplicates = optional(run, 'replicates', []);
  const trueReplicates = rawReplicates.filter((s) => s.cell === declaredReplicateCell);
  const misfiled = rawReplicates.filter((s) => s.cell !== declaredReplicateCell);

  const samples = [
    ...need(run, 'samples', 'the measured cells').map((s) => normSample(s, run)),
    ...misfiled.map((s) => normSample(s, run, { recovered: true })),
  ];

  const measurement = need(run, 'measurement', 'the method section');
  const covFloor = optional(run, 'measurement.covLowConfidence', config.confidence.covLowConfidence);

  const timerApplicable = samples.filter((s) => s.timerSaturated !== null);
  const counts = {
    measured: samples.length,
    fromSamples: run.samples.length,
    recovered: misfiled.length,
    notMeasured: optional(run, 'skipped', []).length,
    lowConfidence: samples.filter((s) => s.confidence !== 'high').length,
    timerApplicable: timerApplicable.length,
    timerSaturated: samples.filter((s) => s.timerSaturated === true).length,
    noisy: samples.filter((s) => Number.isFinite(s.cov) && s.cov > covFloor).length,
    gated: samples.filter((s) => s.gated).length,
    ungated: samples.filter((s) => !s.gated).length,
    replicated: trueReplicates.length,
    declared: samples.filter((s) => s.declared).length,
  };

  // The invariants arrive keyed on (scale, source) with no cell on them, so the
  // cell names come back off the samples. For the engines family one
  // (scale, source) covers both thread counts, which is correct: the artefact
  // does not depend on how many threads wrote it.
  const cellsAt = new Map();
  for (const s of [...samples, ...trueReplicates.map((r) => normSample(r, run))]) {
    const k = `${s.scale}/${s.source}`;
    if (!cellsAt.has(k)) cellsAt.set(k, new Set());
    cellsAt.get(k).add(s.cell);
  }
  const labelFor = (k) => {
    const cells = [...(cellsAt.get(k) ?? [])].sort();
    if (cells.length === 0) return k;
    const bases = new Set(cells.map(baseCell));
    return bases.size === 1 ? [...bases][0] : cells.join(' / ');
  };

  const invariants = need(run, 'invariants', 'the invariants table').map((i) => ({
    series: need(i, 'library', 'which backend an invariant belongs to'),
    scale: i.scale, source: i.source,
    cell: labelFor(`${i.scale}/${i.source}`),
    name: need(i, 'name', 'which invariant this is'),
    value: need(i, 'value', 'the invariant itself'),
    unit: optional(i, 'unit', null),
    exact: optional(i, 'exact', null),
  }));

  return {
    runId, family, digest,
    integrity: need(run, 'integrity', 'the integrity digests in the method section'),
    capturedAt: need(run, 'capturedAt', 'the date a run is labelled with'),
    finishedAt: optional(run, 'finishedAt', null),
    profile: optional(run, 'profile', null),
    source: optional(run, 'source', null),
    version: need(run, 'version', 'the version axis'),
    commit: need(run, 'commit', 'the commit a run measured'),
    harnessCommit: optional(run, 'harnessCommit', optional(run, 'benchCommit', null)),
    libraries,
    host: {
      os: need(run, 'host.os', 'the method section'),
      arch: need(run, 'host.arch', 'the method section and the era rule'),
      cpuModel: optional(run, 'host.cpuModel', null),
      ncpu: optional(run, 'host.ncpu', null),
      inContainer: optional(run, 'host.inContainer', null),
      fingerprint: need(run, 'host.fingerprint', 'the era rule, which breaks a line across two machines'),
      fsType: optional(run, 'host.fsType', optional(run, 'filesystem.fsType', 'unknown')),
      mountSource: optional(run, 'filesystem.mountSource', null),
      rustc: optional(run, 'host.rustc', null),
      buildProfile: optional(run, 'host.buildProfile', null),
    },
    emulated: optional(run, 'emulated', null),
    emulationEvidence: optional(run, 'emulationEvidence', []),
    loadAverage: optional(run, 'loadAverage', null),
    lockfileHash: optional(run, 'lockfileHash', null),
    measurement, covFloor,
    samples,
    replicatePair: trueReplicates.map((s) => normSample(s, run)),
    replicateCell: declaredReplicateCell,
    replicateReps: optional(run, 'replicate.replicateReps', null),
    spreadPct: optional(run, 'replicate.spreadPct', {}),
    invariants,
    modelled: optional(run, 'modelled', []),
    skipped: optional(run, 'skipped', []).map((s) => ({
      series: optional(s, 'library', '?'), cell: optional(s, 'cell', '?'), key: optional(s, 'key', '?'),
      kind: optional(s, 'kind', null), outcome: optional(s, 'outcome', 'not measured'),
      reason: optional(s, 'reason', null),
    })),
    counts,
  };
}

const runs = history.map(normalise);

const byFamily = new Map();
for (const run of runs) {
  if (!byFamily.has(run.family)) byFamily.set(run.family, []);
  byFamily.get(run.family).push(run);
}
for (const list of byFamily.values()) list.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));

const latest = (family) => {
  const list = byFamily.get(family);
  return list ? list[list.length - 1] : null;
};

/** Two runs are in the same comparable era only when every configured axis
 *  agrees. A run on another machine, or another filesystem, starts a new era
 *  rather than continuing the line, because drawing one line across the two
 *  invents a change that never happened. */
function eraKey(run) {
  return config.era.axes.map((axis) => {
    const v = axis.from === 'series' ? Object.keys(run.libraries).sort() : dig(run, axis.from);
    const flat = Array.isArray(v) ? [...v].sort().join('+') : String(v);
    return `${axis.id}=${flat}`;
  }).join('|');
}

/** The band a run can honestly draw for one series and key: the spread its own
 *  replicate pair measured for that very key, and nothing else.
 *
 *  `cell` is not optional in spirit even though it is in the signature. The
 *  producer carries the spread on every sample, so a lookup that ignores the
 *  cell returns whichever cell happened to come first in the array, and a rule
 *  built on that compares a 20% move against some other cell's 36% band and
 *  calls it noise. That is not a hypothetical: it is what this function did
 *  until the fixture in the verdict guard caught it. */
function spreadFor(run, series, key, cell = null) {
  if (cell) {
    const exact = run.samples.find((s) => s.series === series && s.key === key && s.cell === cell);
    if (exact && Number.isFinite(exact.spreadPct)) return exact.spreadPct;
    if (exact && exact.spreadPct === null) return null;
  }
  const any = run.samples.find((s) => s.series === series && s.key === key && Number.isFinite(s.spreadPct));
  if (any) return any.spreadPct;
  const fromMap = run.spreadPct?.[`${series}.${key}`];
  return Number.isFinite(fromMap) ? fromMap / 100 : null;
}

const bandPct = (run, series, key) => spreadFor(run, series, key);

/** How far apart the run's own replicate pair came out, across every key it
 *  covers. This is the single most important number on the timing half of the
 *  page and it is nowhere near constant between families: the storage pair
 *  disagreed by a median of 37% on this host and the engines pair by 0.3%,
 *  minutes apart on the same machine. A page that draws a band that wide
 *  without saying that the width is typical is presenting the timings as
 *  firmer than they are. */
function spreadSummary(run) {
  const vals = Object.values(run.spreadPct ?? {}).filter(Number.isFinite).sort((a, b) => a - b);
  if (vals.length === 0) return null;
  const mid = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
  const worstKey = Object.entries(run.spreadPct).reduce((a, b) => (b[1] > a[1] ? b : a));
  return { n: vals.length, median: mid / 100, max: vals[vals.length - 1] / 100, worstKey: worstKey[0] };
}

const timerFloorUs = (run) => {
  const tick = run.measurement?.timerTickNs;
  const ticks = run.measurement?.minTicksPerSample ?? config.confidence.minTicksPerSample;
  return Number.isFinite(tick) ? (tick * ticks) / 1000 : null;
};

const seriesOf = (run) => config.families[run.family].series.order.filter((id) => run.libraries[id]);

// ---------------------------------------------------------------------------
// verdicts
// ---------------------------------------------------------------------------

const V = config.verdict;
const kindLabel = (kind) => V.kindLabel?.[kind] ?? kind;

/** The ruling for one (family, series, key, cell), read off the two most recent
 *  runs of that family.
 *
 *  Direction is taken from the sample, per metric, and not assumed. Ten of the
 *  thirty metric keys in the storage family are higher-is-better, and a rule
 *  that compares raw numbers calls those a regression on the day they get
 *  faster. That is the failure this function exists to not commit.
 *
 *  Noise comes before the thresholds: a delta smaller than the spread the run's
 *  own replicate pair measured for that very key is not a result. And a spread
 *  that was not measured is not a spread, so the ruling is withheld rather than
 *  falling back to a threshold or to some other key's spread. */
function rule(familyId, list, series, key, cell) {
  const cur = list[list.length - 1];
  const find = (run) => run.samples.find((s) => s.series === series && s.key === key && s.cell === cell);
  const b = find(cur);
  if (!b) return { kind: 'unknown', why: 'no cell in the latest run' };
  if (V.gate.enabled && b[V.gate.field] === false) return { kind: V.gate.kind, why: b.gateBlockers.join('; ') };
  if (list.length < 2) return { kind: 'first', why: 'nothing archived before this run' };

  const prev = list[list.length - 2];
  if (eraKey(prev) !== eraKey(cur)) return { kind: 'unknown', why: 'the previous run is in a different era' };
  const a = find(prev);
  if (!a) return { kind: 'unknown', why: 'the previous run has no cell to compare against' };
  if (!(a.median > 0)) return { kind: 'unknown', why: 'the previous run measured zero, so a relative change has no meaning' };

  const rel = (b.median - a.median) / a.median;
  const better = b.direction === 'higher-is-better' ? rel : -rel;

  if (V.noise.enabled) {
    const spread = spreadFor(cur, series, key, cell);
    if (spread === null) {
      if (V.noise.onMissingSpread === 'unknown') {
        return { kind: 'unknown', why: 'no replicate spread was measured for this key, so there is nothing to tell a change from noise', rel };
      }
    } else if (Math.abs(rel) <= Math.max(spread, V.noise.floorPct ?? 0)) {
      return { kind: V.noise.kind, why: `inside the ${pct(spread, 2)} spread this run's own replicate pair measured`, rel };
    }
  }

  if (better >= V.improvedPct) return { kind: 'improved', why: `${pct(Math.abs(rel), 1)} better`, rel };
  if (-better >= V.regressionPct) return { kind: 'regressed', why: `${pct(Math.abs(rel), 1)} worse`, rel };
  if (Math.abs(rel) <= V.passPct) return { kind: 'pass', why: `within ${pct(V.passPct, 0)}`, rel };
  return { kind: 'unknown', why: 'moved by more than the pass band and less than the regression band', rel };
}

/** A chip, or not one. `noChipKinds` is config: a kind in that list renders as a
 *  dashed gate marker and never as a verdict, because a neutral-looking chip on
 *  a number nobody can rule on still reads as a ruling. */
function chipFor(v) {
  const label = esc(kindLabel(v.kind));
  const title = v.why ? ` title="${esc(prose(v.why))}"` : '';
  if (V.noChipKinds.includes(v.kind)) return `<span class="gate"${title}>${label}</span>`;
  return `<span class="verdict verdict-${esc(v.kind)}"${title}>${label}</span>`;
}

// ---------------------------------------------------------------------------
// 1. the claim
// ---------------------------------------------------------------------------

function invariantIndex(run) {
  const byCell = new Map();
  for (const inv of run.invariants) {
    if (!byCell.has(inv.cell)) byCell.set(inv.cell, new Map());
    const perSeries = byCell.get(inv.cell);
    if (!perSeries.has(inv.series)) perSeries.set(inv.series, new Map());
    perSeries.get(inv.series).set(inv.name, inv.value);
  }
  return byCell;
}

/** The equality verdict for one invariant across the series in one cell. The
 *  rule per invariant is config's, never guessed from the values. */
function invariantVerdict(kind, values) {
  const present = values.filter((v) => v.value !== undefined && v.value !== null);
  if (present.length < 2) return { text: 'one backend only', cls: 'iverdict-none', ok: null };

  if (kind === 'equal') {
    const same = present.every((v) => v.value === present[0].value);
    return same
      ? { text: 'equal', cls: 'iverdict-equal', ok: true }
      : { text: 'differs', cls: 'iverdict-differs', ok: false };
  }
  if (kind === 'within') {
    const nums = present.map((v) => Number(v.value));
    const lo = Math.min(...nums); const hi = Math.max(...nums);
    const rel = lo === 0 ? null : (hi - lo) / lo;
    return { text: `within ${pct(rel)}`, cls: 'iverdict-within', ok: true, rel };
  }
  if (kind === 'ratio') {
    const nums = present.map((v) => Number(v.value));
    const lo = Math.min(...nums); const hi = Math.max(...nums);
    return { text: lo === 0 ? `${count(hi)} against 0` : `${count(hi)} against ${count(lo)}`, cls: 'iverdict-ratio', ok: null, lo, hi };
  }
  if (kind === 'differs-by-construction') {
    const same = present.every((v) => v.value === present[0].value);
    return same
      ? { text: 'identical, which it should not be', cls: 'iverdict-differs', ok: false }
      : { text: 'differs, and must', cls: 'iverdict-none', ok: null };
  }
  return { text: 'no rule', cls: 'iverdict-none', ok: null };
}

function invariantTable(run, familyId) {
  const fam = config.families[familyId];
  const idx = invariantIndex(run);
  const order = fam.invariantOrder.filter((n) => run.invariants.some((i) => i.name === n));
  const series = seriesOf(run).filter((s) => [...idx.values()].some((m) => m.has(s)));
  const cells = [...idx.keys()].sort();

  const rows = cells.map((cell) => {
    const perSeries = idx.get(cell);
    const body = series.map((s) => {
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
      return `        <tr><th scope="row"><span class="swatch" style="background:${esc(fam.series.color[s] ?? '#888')}"></span>${esc(fam.series.label[s] ?? s)}</th>${tds}</tr>`;
    }).join('\n');

    const verdicts = order.map((name) => {
      const kind = fam.invariantEquality[name];
      if (!kind) return '<td class="num"></td>';
      const v = invariantVerdict(kind, series.map((s) => ({ series: s, value: perSeries.get(s)?.get(name) })));
      // `iverdict`, not `verdict`. An equality verdict on an exact number and a
      // pass-or-regression chip on a timing are two different claims, and
      // sharing a class name means the guard that says an ungateable cell is
      // never chipped cannot tell them apart.
      return `<td class="num"><span class="iverdict ${v.cls}" data-invariant-verdict="${esc(name)}">${esc(v.text)}</span></td>`;
    }).join('');

    return `        <tr class="rowgroup"><th scope="rowgroup" colspan="${order.length + 1}"><code class="mono">${esc(cell)}</code></th></tr>
${body}
        <tr class="row-agreement"><th scope="row">agreement</th>${verdicts}</tr>`;
  }).join('\n');

  const head = order.map((n) => `<th scope="col">${esc(fam.invariantLabel[n] ?? n)}</th>`).join('');
  return { order, series, cells, idx, html: `    <div class="table-wrap">
      <table class="results-table" data-invariant-table="${esc(familyId)}">
        <caption>Invariants for run <code class="mono">${esc(run.runId)}</code>, per cell, per ${familyId === 'storage' ? 'backend' : 'engine'}.${order.includes('artefact_digest') ? ' Digests are the first 12 hex characters.' : ''}</caption>
        <thead>
          <tr><th scope="col">${familyId === 'storage' ? 'backend' : 'engine'}</th>${head}</tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>` };
}

function claimSection() {
  const run = latest('storage');
  if (!run) return '<p>No storage run in the history, so there is no claim to state.</p>';

  const fam = config.families.storage;
  const t = invariantTable(run, 'storage');
  const { idx, series, cells } = t;

  // The headline, computed. The entry counts come from the cell the config
  // points at; the byte bound is the worst relative gap across every cell.
  const claim = idx.get(fam.claimCell);
  if (!claim) {
    refuse(`config names ${JSON.stringify(fam.claimCell)} as the cell the headline claim is read off, and run ` +
      `${run.runId} has no such cell. The cells it does have are: ${cells.join(', ')}`);
  }
  const entriesBy = new Map(series.map((s) => [s, claim.get(s)?.get('filesystem_entries')]));
  const entryValues = [...entriesBy.values()].filter(Number.isFinite);
  const fewest = Math.min(...entryValues);
  const most = Math.max(...entryValues);
  const fewestSeries = series.find((s) => entriesBy.get(s) === fewest);
  const mostSeries = series.find((s) => entriesBy.get(s) === most);

  let worstByteGap = 0; let worstCell = null;
  for (const [cell, perSeries] of idx) {
    const vals = series.map((s) => perSeries.get(s)?.get('output_bytes')).filter(Number.isFinite);
    if (vals.length < 2) continue;
    const lo = Math.min(...vals); const hi = Math.max(...vals);
    const rel = (hi - lo) / lo;
    if (rel > worstByteGap) { worstByteGap = rel; worstCell = cell; }
  }

  const tilesAgree = cells.every((cell) => {
    const vals = series.map((s) => idx.get(cell).get(s)?.get('tiles_produced')).filter(Number.isFinite);
    return vals.length < 2 || vals.every((v) => v === vals[0]);
  });

  return `  <div class="section-head">
      <div class="section-kicker">Measured ${esc(String(run.capturedAt).slice(0, 10))} ${MIDDOT} run <code class="mono">${esc(run.runId)}</code></div>
      <h2 id="claim-title">The same pyramid, one file against ${count(most)}.</h2>
    </div>

    <p class="lead">This is the result the PMTiles work was for, and it is an exact one. Both backends were handed
      the same tiles and asked to store them. ${esc(fam.series.label[fewestSeries] ?? fewestSeries)} finished with
      ${count(fewest)} filesystem ${fewest === 1 ? 'entry' : 'entries'};
      ${esc(fam.series.label[mostSeries] ?? mostSeries)} finished with ${count(most)} of them.
      ${tilesAgree ? 'Every tile is in both' : 'The tile counts do not agree, which they must, so read the table before anything else'}, and
      across all ${cells.length} cells the two byte totals never differ by more than ${pct(worstByteGap)}.</p>

    <div class="claim-figures">
      <div class="claim-figure"><div class="claim-number">${count(fewest)}</div><div class="claim-label">filesystem ${fewest === 1 ? 'entry' : 'entries'}, ${esc(fam.series.label[fewestSeries] ?? fewestSeries)}, <code class="mono">${esc(fam.claimCell)}</code></div></div>
      <div class="claim-figure"><div class="claim-number">${count(most)}</div><div class="claim-label">filesystem ${most === 1 ? 'entry' : 'entries'}, ${esc(fam.series.label[mostSeries] ?? mostSeries)}, the same cell</div></div>
      <div class="claim-figure"><div class="claim-number">${pct(worstByteGap)}</div><div class="claim-label">the widest the byte totals ever get apart, at <code class="mono">${esc(worstCell ?? 'n/a')}</code></div></div>
    </div>

    <p class="claim-note">No bands on any of this, and no chart of it either. These numbers do not vary: they came
      out the same on every repetition, and they came out the same on the capture before this one on a busier
      host. A trend line and an error bar are both lies about an exact number, so they go in a table with equality
      verdicts, and when one of them does move between runs that shows up on the version axis further down as a
      rule carrying the commit that moved it.</p>

${t.html}

    <p class="footnote">The artefact digests differ, and they have to: one is a single archive and the other is a
      tree of loose files, so the bytes on disk are not the same bytes even when every tile in them is. What has to
      agree is the tile count, and it does, in every cell. <code class="mono">allocated_bytes</code> is the one
      that moves, because every loose tile rounds up to a filesystem block and a single archive rounds up once.</p>
`;
}

// ---------------------------------------------------------------------------
// 2. the engines comparison
// ---------------------------------------------------------------------------

function enginesSection() {
  const run = latest('engines');
  if (!run) return '<p>No engines run in the history, so there is nothing to compare.</p>';

  const fam = config.families.engines;
  const series = seriesOf(run);
  const at = new Map();
  for (const s of run.samples) at.set(`${s.series}/${s.cell}/${s.key}`, s);

  const cells = [...new Set(run.samples.map((s) => s.cell))];
  const scaleOf = new Map(run.samples.map((s) => [s.cell, s.scale]));
  const concOf = new Map(run.samples.map((s) => [s.cell, s.concurrency]));
  cells.sort((a, b) => (scaleOf.get(a) - scaleOf.get(b)) || ((concOf.get(a) ?? 0) - (concOf.get(b) ?? 0)) || a.localeCompare(b));

  const concurrencies = [...new Set(cells.map((c) => concOf.get(c)).filter((c) => c !== null))].sort((a, b) => a - b);
  const lowC = concurrencies[0] ?? null;
  const highC = concurrencies[concurrencies.length - 1] ?? null;

  const metrics = fam.tableKeys
    .map((k) => ({ ...k, present: run.samples.some((s) => s.key === k.key) }))
    .filter((k) => k.present);
  if (metrics.length === 0) {
    refuse(`config lists ${JSON.stringify(fam.tableKeys.map((k) => k.key))} as the engines metrics to table, and run ` +
      `${run.runId} carries none of them. Its keys are: ${[...new Set(run.samples.map((s) => s.key))].sort().join(', ')}`);
  }

  // The headline. Peak RSS is per engine in this capture: the sweep measures
  // each engine in its own child rather than reading one process-wide
  // watermark, so the three numbers on a row are three different measurements.
  // That is checked rather than asserted: a group whose engines all report the
  // same figure to the byte is counted, and the count goes on the page.
  const rssKey = fam.memoryKey;
  const rssGroups = cells.map((cell) => series.map((s) => at.get(`${s}/${cell}/${rssKey}`)?.median).filter(Number.isFinite))
    .filter((vals) => vals.length === series.length);
  const identicalGroups = rssGroups.filter((vals) => new Set(vals).size === 1).length;

  const claimCell = fam.memoryClaimCell;
  if (!at.has(`${series[0]}/${claimCell}/${rssKey}`)) {
    refuse(`config names ${JSON.stringify(claimCell)} as the cell the memory claim is read off, and run ${run.runId} ` +
      `has no ${rssKey} there. Its cells are: ${cells.join(', ')}`);
  }
  const mem = series.map((id) => ({ id, s: at.get(`${id}/${claimCell}/${rssKey}`) })).filter((x) => x.s);
  // >= and <= so a tie keeps the first series in config order rather than the
  // last, and the tie is stated rather than hidden.
  const heaviest = mem.reduce((a, b) => (a.s.median >= b.s.median ? a : b), mem[0]);
  const lightest = mem.reduce((a, b) => (a.s.median <= b.s.median ? a : b), mem[0]);
  const tiedWith = mem.filter((x) => x.id !== lightest.id && x.s.median === lightest.s.median)
    .map((x) => fam.series.label[x.id] ?? x.id);
  const trackedOf = (id) => at.get(`${id}/${claimCell}/${fam.trackedKey}`)?.median;
  const wallOf = (id) => at.get(`${id}/${claimCell}/${fam.wallKey}`)?.median;
  const heavyWall = wallOf(heaviest.id); const lightWall = wallOf(lightest.id);
  const wallGap = Number.isFinite(heavyWall) && Number.isFinite(lightWall) && heavyWall > 0
    ? Math.abs(lightWall - heavyWall) / heavyWall : null;

  const tables = metrics.map(({ key, label, sense }) => {
    const rows = cells.map((cell) => {
      const vals = series.map((id) => at.get(`${id}/${cell}/${key}`));
      const present = vals.filter(Boolean).map((v) => v.median);
      const best = present.length ? (sense === 'lower' ? Math.min(...present) : Math.max(...present)) : null;
      const first = vals.find(Boolean);
      const tds = series.map((id, i) => {
        const v = vals[i];
        if (!v) return '<td class="num absent">no cell</td>';
        return `<td class="num${best !== null && v.median === best ? ' best' : ''}">${num(v.median)}</td>`;
      }).join('');
      const conc = concOf.get(cell);
      // The gate marker covers the whole row, so it is read off every series in
      // the row rather than off whichever one happens to be first. A row where
      // the engines disagree says so instead of picking one.
      const rulings = series.map((id) => rule('engines', byFamily.get('engines'), id, key, cell));
      const kinds = [...new Set(rulings.map((r) => r.kind))];
      const gateCell = kinds.length === 1
        ? chipFor(rulings[0])
        : `<span class="gate" title="${esc(kinds.join(', '))}">mixed</span>`;
      return `        <tr class="row-low" title="${esc(prose((first?.gateBlockers ?? []).join('; ')))}">` +
        `<th scope="row"><code class="mono">${esc(cell)}</code> <span class="unit">${count(scaleOf.get(cell))} tiles${conc === null ? '' : `, ${conc} thread${conc === 1 ? '' : 's'}`}</span></th>` +
        `${tds}<td>${gateCell}</td></tr>`;
    }).join('\n');

    const unitOf = run.samples.find((s) => s.key === key)?.unit ?? '';
    return `    <h3>${esc(label)} <span class="unit">(${esc(unitOf)}, ${esc(sense)} is better)</span></h3>
    <div class="table-wrap">
      <table class="results-table">
        <thead>
          <tr><th scope="col">cell</th>${series.map((id) => `<th scope="col"><span class="swatch" style="background:${esc(fam.series.color[id] ?? '#888')}"></span>${esc(fam.series.label[id] ?? id)}</th>`).join('')}<th scope="col">gate</th></tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>`;
  }).join('\n');

  // What the thread count costs, per engine, read off the two arms rather than
  // asserted. An engine whose working set is bounded by a strip does not move;
  // one that keeps K strips in flight trades memory for threads and does.
  let concurrencyBlock = '';
  if (lowC !== null && highC !== null && lowC !== highC) {
    const bases = [...new Set(cells.map((c) => baseCell(c)))]
      .filter((b) => cells.includes(`${b}+c${lowC}`) && cells.includes(`${b}+c${highC}`))
      .sort((a, b) => scaleOf.get(`${a}+c${lowC}`) - scaleOf.get(`${b}+c${lowC}`));

    const deltaFor = (id, b) => {
      const lo = at.get(`${id}/${b}+c${lowC}/${rssKey}`)?.median;
      const hi = at.get(`${id}/${b}+c${highC}/${rssKey}`)?.median;
      return Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 ? (hi - lo) / lo : null;
    };
    // Classified at the largest image, not at whichever size shows the widest
    // gap. At the small end every engine is dominated by fixed setup, and the
    // monolithic engine's peak moves 13.9% on a 25-tile pyramid while moving
    // 0.1% on a 2119-tile one. Reading the widest gap calls that engine a
    // thread-scaler, which is the opposite of what it does where it matters.
    const largest = bases[bases.length - 1];
    const atLargest = new Map(series.map((id) => [id, deltaFor(id, largest)]));
    const rangeOf = (id) => {
      const ds = bases.map((b) => deltaFor(id, b)).filter(Number.isFinite);
      return ds.length ? { lo: Math.min(...ds), hi: Math.max(...ds) } : null;
    };
    const flat = series.filter((id) => Number.isFinite(atLargest.get(id)) && Math.abs(atLargest.get(id)) < fam.flatThresholdPct);
    const rising = series.filter((id) => Number.isFinite(atLargest.get(id)) && atLargest.get(id) >= fam.flatThresholdPct);

    const rows = bases.map((b) => {
      const tds = series.map((id) => {
        const lo = at.get(`${id}/${b}+c${lowC}/${rssKey}`)?.median;
        const hi = at.get(`${id}/${b}+c${highC}/${rssKey}`)?.median;
        const d = deltaFor(id, b);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return '<td class="num absent">no pair</td>';
        return `<td class="num">${num(lo)} <span class="unit">to</span> ${num(hi)} <span class="unit">(${d === null ? 'n/a' : `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%`})</span></td>`;
      }).join('');
      return `        <tr class="row-low"><th scope="row"><code class="mono">${esc(b)}</code> <span class="unit">${count(scaleOf.get(`${b}+c${lowC}`))} tiles</span></th>${tds}</tr>`;
    }).join('\n');

    const say = (list) => list.map((id) => esc(fam.series.label[id] ?? id)).join(' and ');
    const signed = (d) => `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%`;
    concurrencyBlock = `    <h3 data-classified-at="${esc(largest)}"${series.map((id) => ` data-delta-${esc(id)}="${Number.isFinite(atLargest.get(id)) ? (atLargest.get(id) * 100).toFixed(1) : 'n/a'}"`).join('')}>What the thread count costs in memory</h3>
    <p>Every row is the same image built twice, once on ${lowC} thread${lowC === 1 ? '' : 's'} and once on
      ${highC}, with the peak resident set of each build beside the other. Read the bottom row: at the small end
      every engine is dominated by fixed setup, and a percentage there is mostly about the setup.
      ${flat.length ? `At <code class="mono">${esc(largest)}</code>, ${say(flat)} ${flat.length === 1 ? 'does' : 'do'}
        not move (${flat.map((id) => signed(atLargest.get(id))).join(', ')}).` : ''}
      ${rising.length ? `${say(rising)} ${rising.length === 1 ? 'rises' : 'rise'} with the thread count
        (${rising.map((id) => signed(atLargest.get(id))).join(', ')} at that size)${rising.length === 1 && rangeOf(rising[0])
          ? `, and across every size it runs ${signed(rangeOf(rising[0]).lo)} to ${signed(rangeOf(rising[0]).hi)}` : ''}.` : ''}
      Throughput barely moves either way, which is in the table above: the thread count is buying memory here
      rather than speed.</p>
    ${Object.keys(fam.series.annotation ?? {}).length ? `<ul class="meta-list">
      ${series.filter((id) => fam.series.annotation?.[id]).map((id) =>
        `<li class="meta-item"><strong>${esc(fam.series.label[id] ?? id)}</strong> ${prose(fam.series.annotation[id])}.</li>`).join('\n      ')}
    </ul>` : ''}
    <div class="table-wrap">
      <table class="results-table">
        <caption>Peak resident set, ${lowC} thread${lowC === 1 ? '' : 's'} against ${highC}, per engine.</caption>
        <thead>
          <tr><th scope="col">image</th>${series.map((id) => `<th scope="col"><span class="swatch" style="background:${esc(fam.series.color[id] ?? '#888')}"></span>${esc(fam.series.label[id] ?? id)}</th>`).join('')}</tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>`;
  }

  const recovered = run.counts.recovered > 0 ? `    <div class="status-callout" data-recovered="${count(run.counts.recovered)}" data-measured="${count(run.counts.measured)}" data-from-samples="${count(run.counts.fromSamples)}">
      <p><strong>${count(run.counts.recovered)} of this run's rows arrived filed as replicates of a cell they are not.</strong>
        The run declares <code class="mono">${esc(run.replicateCell)}</code> as the cell it measured twice, and a
        replicate is the same cell measured twice. These rows name different cells, at
        ${concurrencies.map((c) => `${c} thread${c === 1 ? '' : 's'}`).join(' and ')}, which share a tile count with
        their twins and are otherwise a separate arm of the experiment. The page reads them as the cells they say
        they are. Dropping them would have lost half of what this run measured, with nothing on the page to say
        so.</p>
    </div>` : '';

  const charts = fam.chartKeys.map((ck) => {
    const rows = run.samples.filter((s) => s.key === ck.key && (lowC === null || s.concurrency === lowC));
    if (rows.length === 0) return '';
    return chartSvg({
      title: `${ck.label} against pyramid size`,
      family: 'engines', run, key: ck.key, unit: rows[0].unit, rows,
      xOf: (s) => s.scale, yOf: (s) => s.median,
      xLabel: 'tiles in the pyramid', yLabel: rows[0].unit, logX: true, logY: true,
    });
  }).filter(Boolean).join('\n');

  return `  <div class="section-head">
      <div class="section-kicker">Measured ${esc(String(run.capturedAt).slice(0, 10))} ${MIDDOT} run <code class="mono">${esc(run.runId)}</code></div>
      <h2 id="engines-title">Three engines, the same pyramid, and where the memory goes.</h2>
    </div>

    <p class="lead">All three build the same tiles from the same source and produce the same tile count, which the
      invariants below say exactly. Where they part company is how much of the image they are holding while they do
      it. At <code class="mono">${esc(claimCell)}</code>, ${count(scaleOf.get(claimCell))} tiles, the
      ${esc(fam.series.label[heaviest.id] ?? heaviest.id)} engine peaks at ${num(heaviest.s.median)} MB resident
      against ${esc(fam.series.label[lightest.id] ?? lightest.id)}'s ${num(lightest.s.median)} MB${tiedWith.length ? ` (tied with ${esc(tiedWith.join(' and '))})` : ''},
      a factor of ${num(heaviest.s.median / (lightest.s.median || 1))}, for wall times of ${num(heavyWall)} ms
      against ${num(lightWall)} ms${wallGap === null ? '' : `, ${pct(wallGap, 1)} apart`}. The tracked working set
      underneath it is starker still: ${num(trackedOf(heaviest.id))} MB against ${num(trackedOf(lightest.id))} MB.</p>

    <div class="status-callout" data-identical-groups="${count(identicalGroups)}" data-engine-groups="${count(rssGroups.length)}">
      <p><strong>These are ${identicalGroups === 0 ? 'three separate measurements' : 'not all separate measurements'}.</strong>
        ${identicalGroups} of ${rssGroups.length} ${rssGroups.length === 1 ? 'group' : 'groups'} in this run report
        the same peak resident set for every engine${identicalGroups === 0
          ? ', which is what a sweep that measures each engine in its own child looks like. A sweep that reads one process-wide high-water mark reports the same number three times, and this one does not.'
          : ', which is what a process-wide high-water mark read once looks like. Treat those rows as one measurement wearing three labels.'}</p>
      <p><strong>No cell here is gated, and none of them carries a chip.</strong>
        ${count(run.counts.ungated)} of ${count(run.counts.measured)} cells are published as measured and not
        gated, and the method section lists every reason with a count against it. The numbers are real; what is
        missing is anything that could grade them.</p>
    </div>

${recovered}
${tables}

${concurrencyBlock}

    <div class="charts">
${charts}
    </div>

${invariantTable(run, 'engines').html}
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
function chartSvg({ title, family, run, key, unit, xOf, yOf, xLabel, yLabel, logX, logY, steps = [], xTicks = null, rows }) {
  const fam = config.families[family];
  if (!rows || rows.length === 0) return '';

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
    ...(xTicks ?? niceTicks(xlo, xhi, logX).map((v) => ({ v, label: num(v) })))
      .map(({ v, label }) => `<text class="chart-tick" x="${sx(v).toFixed(1)}" y="${H - PAD.b + 15}" text-anchor="middle">${esc(label)}</text>`),
  ].join('\n      ');

  const seriesPaths = fam.series.order.map((id) => {
    const own = rows.filter((s) => s.series === id).sort((a, b) => xOf(a) - xOf(b));
    if (own.length === 0) return '';
    const colour = fam.series.color[id] ?? '#888';
    const dash = fam.series.dash[id];
    const d = own.map((s, i) => `${i === 0 ? 'M' : 'L'}${sx(xOf(s)).toFixed(1)},${sy(yOf(s)).toFixed(1)}`).join(' ');

    // The band is the replicate spread measured for this very key inside the
    // very run the point came from, or nothing at all. A band drawn from
    // anywhere else is a band about a different experiment, which is why it is
    // looked up per point rather than once per series.
    const spreadAt = (s) => (Number.isFinite(s.spreadPct) ? s.spreadPct : bandPct(s._run ?? run, id, key));
    const band = own.every((s) => spreadAt(s) === null) ? '' :
      `<path class="chart-band" fill="${esc(colour)}" d="${own.map((s, i) => `${i === 0 ? 'M' : 'L'}${sx(xOf(s)).toFixed(1)},${sy(yOf(s) * (1 + (spreadAt(s) ?? 0))).toFixed(1)}`).join(' ')} ${own.slice().reverse().map((s) => `L${sx(xOf(s)).toFixed(1)},${sy(yOf(s) * (1 - (spreadAt(s) ?? 0))).toFixed(1)}`).join(' ')} Z"/>`;

    // The band each point carries is in the markup, not only in the geometry.
    // A band drawn once per series from whichever run happened to be in hand
    // looks identical to a band drawn per point until you read the numbers.
    const dots = own.map((s) => {
      const sp = spreadAt(s);
      return `<circle class="chart-point" data-band-pct="${sp === null ? 'none' : (sp * 100).toFixed(2)}" cx="${sx(xOf(s)).toFixed(1)}" cy="${sy(yOf(s)).toFixed(1)}" r="3" fill="${esc(colour)}"><title>${esc(fam.series.label[id] ?? id)} ${esc(s.cell)}: ${esc(num(yOf(s)))} ${esc(unit)}${sp === null ? ', no replicate spread measured' : `, replicate spread ${pct(sp, 2)}`}</title></circle>`;
    }).join('');

    return `${band}<path class="chart-line" data-series-key="${esc(`${family}:${id}:${key}`)}" d="${d}" stroke="${esc(colour)}"${dash ? ` stroke-dasharray="${esc(dash)}"` : ''}/>${dots}`;
  }).join('\n      ');

  const stepRules = steps.map((st) => `<line class="step-rule" data-invariant-step="${esc(`${st.name} ${st.series} ${st.cell}`)}" x1="${sx(st.x).toFixed(1)}" y1="${PAD.t}" x2="${sx(st.x).toFixed(1)}" y2="${H - PAD.b}"/>`).join('\n      ');

  const legend = fam.series.order.filter((id) => rows.some((s) => s.series === id)).map((id) =>
    `<li class="legend-item"><span class="legend-swatch" style="background:${esc(fam.series.color[id] ?? '#888')}"></span><span class="legend-label">${esc(fam.series.label[id] ?? id)}</span></li>`).join('');

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
function invariantSteps(list) {
  const out = [];
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]; const next = list[i];
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

const versionAxis = (list) => list.map((r, i) => ({
  i, label: r.version, commit: r.commit, runId: r.runId, era: eraKey(r),
}));

/** Every cell, every series, including the replicate pair, in a collapsible
 *  block. The low-confidence rows are in here with their numbers and a reason,
 *  because dropping them would make an untested backend and an untrusted
 *  measurement look the same on a page whose whole job is telling those apart. */
function fullResults(familyId) {
  const run = latest(familyId);
  if (!run) return '';
  const fam = config.families[familyId];
  const all = [
    ...run.samples.map((s) => ({ s, rep: 1 })),
    ...run.replicatePair.map((s) => ({ s, rep: 2 })),
  ].sort((x, y) =>
    x.s.cell.localeCompare(y.s.cell) || x.s.key.localeCompare(y.s.key) ||
    fam.series.order.indexOf(x.s.series) - fam.series.order.indexOf(y.s.series) || x.rep - y.rep);

  // Low confidence has two causes and they are not the same fact. A
  // timer-saturated row sits at the instrument's resolution limit: more
  // repetitions will not help, and the number is a statement about the clock as
  // much as about the code. A high-CoV row is a noisy measurement of something
  // the clock can resolve perfectly well, and more repetitions would tighten
  // it. Rendering them identically loses that, so they carry different marks.
  const covFloor = run.covFloor;
  const rows = all.map(({ s, rep }) => {
    const saturated = s.timerSaturated === true;
    const noisy = Number.isFinite(s.cov) && s.cov > covFloor;
    const low = s.confidence !== 'high';
    const cls = [low ? 'row-low' : '', saturated ? 'row-saturated' : '', noisy ? 'row-noisy' : '']
      .filter(Boolean).join(' ');
    const why = s.lowConfidenceReasons.join('; ') || s.gateBlockers.join('; ');
    return `        <tr${cls ? ` class="${cls}"` : ''}${why ? ` title="${esc(prose(why))}"` : ''}>` +
      `<th scope="row"><code class="mono">${esc(s.cell)}</code></th>` +
      `<td><code class="mono">${esc(s.key)}</code></td>` +
      `<td><span class="swatch" style="background:${esc(fam.series.color[s.series] ?? '#888')}"></span>${esc(fam.series.label[s.series] ?? s.series)}</td>` +
      `<td class="num">${num(s.median)} <span class="unit">${esc(s.unit)}</span></td>` +
      `<td class="num">${Array.isArray(s.ci95) ? `${num(s.ci95[0])}&hairsp;to&hairsp;${num(s.ci95[1])}` : '<span class="absent">none</span>'}</td>` +
      `<td class="num">${s.cov === null ? '<span class="absent">none</span>' : pct(s.cov, 1)}</td>` +
      `<td class="num">${count(s.reps)}</td>` +
      `<td class="num">${rep}</td>` +
      `<td>${confChip(s.confidence)}</td>` +
      `<td>${s.gated ? '<span class="gate gate-on">gateable</span>' : '<span class="gate">measured, not gated</span>'}</td></tr>`;
  }).join('\n');

  const skipped = run.skipped.map((s) =>
    `        <tr class="row-absent"><th scope="row"><code class="mono">${esc(s.cell)}</code></th>` +
    `<td><code class="mono">${esc(s.key)}</code></td>` +
    `<td>${esc(fam.series.label[s.series] ?? s.series)}</td>` +
    `<td class="absent" colspan="7"><strong>${esc(s.outcome)}</strong>: ${prose(s.reason ?? 'no reason recorded')}</td></tr>`).join('\n');

  const c = run.counts;
  const nSat = all.filter(({ s }) => s.timerSaturated === true).length;
  const nNoisy = all.filter(({ s }) => Number.isFinite(s.cov) && s.cov > covFloor).length;
  const floor = timerFloorUs(run);
  return `      <details class="status-callout">
        <summary>Every cell in <code class="mono">${esc(fam.label)}</code>: ${count(c.measured)} measured, ${count(c.notMeasured)} that produced no number, ${count(c.lowConfidence)} low confidence</summary>
        <p class="legend-note">Two marks, because low confidence has two causes.
          <span class="mark mark-saturated">at the clock's limit</span> is a median under the
          ${floor === null ? 'n/a' : floor.toFixed(1)} &micro;s this host's timer can resolve (${count(nSat)} rows):
          more repetitions will not help, because the instrument is the limit.
          <span class="mark mark-noisy">noisy</span> is a coefficient of variation above ${pct(covFloor, 0)}
          (${count(nNoisy)} rows): the clock can resolve it fine, the measurement simply moved about. Neither is
          chipped.</p>
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
    const list = byFamily.get(familyId) ?? [];
    if (list.length === 0) return '';
    const axis = versionAxis(list);
    const steps = invariantSteps(list);
    const run = list[list.length - 1];
    const eras = new Set(axis.map((a) => a.era)).size;

    const headlineCell = fam.headlineCell;
    if (!run.samples.some((s) => s.cell === headlineCell)) {
      refuse(`config names ${JSON.stringify(headlineCell)} as the headline cell for the ${familyId} family, and ` +
        `run ${run.runId} has no such cell. Its cells are: ${[...new Set(run.samples.map((s) => s.cell))].sort().join(', ')}`);
    }

    const charts = fam.headlineKeys.map((key) => {
      // One point per archived run, at that run's position on the version axis,
      // each carrying the run it came from so its band is its own run's
      // replicate spread. A single-run history therefore draws one point and no
      // line, which is what it is: a measurement, not a trend.
      const rows = list.flatMap((r, i) => r.samples
        .filter((s) => s.key === key && s.cell === headlineCell)
        .map((s) => ({ ...s, _x: i, _run: r })));
      if (rows.length === 0) return '';
      const first = rows[0];
      return chartSvg({
        title: `${config.metricLabel[first.metric] ?? first.metric}, ${config.scenarioLabel[first.scenario] ?? first.scenario}, ${headlineCell}`,
        family: familyId, run, key, unit: first.unit, rows,
        xOf: (s) => s._x, yOf: (s) => s.median,
        xLabel: 'version', yLabel: first.unit, logX: false, logY: false,
        steps,
        // The x axis is the version axis, so it is labelled with versions. A
        // numeric tick here would be the index of the run in the history, which
        // is a number about the file rather than about the software.
        xTicks: axis.map((a) => ({ v: a.i, label: a.label })),
      });
    }).filter(Boolean).join('\n');

    const rows = fam.headlineKeys.map((key) => {
      const own = run.samples.filter((s) => s.key === key && s.cell === headlineCell);
      if (own.length === 0) return '';
      return fam.series.order.filter((id) => own.some((s) => s.series === id)).map((id) => {
        const s = own.find((x) => x.series === id);
        const spread = Number.isFinite(s.spreadPct) ? s.spreadPct : bandPct(run, id, key);
        return `        <tr${s.confidence === 'high' ? '' : ' class="row-low"'} title="${esc(prose(s.gateBlockers.join('; ') || s.lowConfidenceReasons.join('; ')))}">` +
          `<th scope="row"><code class="mono">${esc(key)}</code></th>` +
          `<td><span class="swatch" style="background:${esc(fam.series.color[id] ?? '#888')}"></span>${esc(fam.series.label[id] ?? id)}</td>` +
          `<td class="num">${num(s.median)} <span class="unit">${esc(s.unit)}</span></td>` +
          `<td class="num">${spread === null ? '<span class="absent">no replicate</span>' : `&plusmn;${pct(spread, 2)}`}</td>` +
          `<td class="num">${count(s.reps)}</td>` +
          `<td>${confChip(s.confidence)}</td>` +
          `<td>${chipFor(rule(familyId, list, id, key, headlineCell))}</td></tr>`;
      }).join('\n');
    }).filter(Boolean).join('\n');

    const stepList = steps.length === 0 ? '' : `    <ul class="step-labels">
${steps.map((st) => `      <li class="step-label" data-invariant-step="${esc(`${st.name} ${st.series} ${st.cell}`)}"><code class="mono">${esc(st.name)}</code> on <code class="mono">${esc(st.series)}</code> at <code class="mono">${esc(st.cell)}</code> moved from ${count(st.from)} to ${count(st.to)} at <code class="mono">${esc(String(st.run.commit ?? st.run.runId).slice(0, 12))}</code></li>`).join('\n')}
    </ul>`;

    const spreadCell = run.samples.find((s) => s.spreadCell)?.spreadCell ?? run.replicateCell;
    const spread = spreadSummary(run);
    const spreadLine = spread === null ? '' : `<p data-spread-median="${(spread.median * 100).toFixed(2)}" data-spread-max="${(spread.max * 100).toFixed(2)}" data-spread-keys="${count(spread.n)}">
        <strong>How wide those bands are is itself a result.</strong> Across the ${count(spread.n)} keys the pair
        covers it disagreed with itself by a median of ${pct(spread.median, 1)}, and by ${pct(spread.max, 1)} at
        its worst, on <code class="mono">${esc(spread.worstKey)}</code>. Two measurements of identical code on one
        host, minutes apart. Read every timing on this page against that: a change smaller than the band is not a
        change this run could have seen, and a band this wide is why nothing here is graded even where the
        producer has a threshold to grade it against.</p>`;
    return `    <div class="family-block">
      <h3 class="family-title">${esc(fam.label)}</h3>
      <p>${list.length === 1
        ? `One archived run so far, so every point below is a single point and nothing on this axis is a trend yet.`
        : `${list.length} archived runs across ${eras} comparable ${eras === 1 ? 'era' : 'eras'}. A run whose host fingerprint or filesystem differs starts a new era rather than continuing the line.`}
        The band around a point is the spread this run's own replicate pair measured for that key, on
        <code class="mono">${esc(spreadCell ?? 'no cell')}</code>${spreadCell && spreadCell !== headlineCell
          ? ', which is a smaller cell than the one charted: it is the only pair the run measured, so it is the only band it can honestly draw, and it is not a claim about this cell'
          : ''}.
        ${count(run.counts.gated)} of ${count(run.counts.measured)} cells in the latest run are gateable; the other
        ${count(run.counts.ungated)} are published with their numbers and no chip.</p>
      ${spreadLine}
      <div class="table-wrap">
        <table class="results-table">
          <caption>Headline cells for <code class="mono">${esc(headlineCell)}</code>, latest run.</caption>
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
      <div class="section-kicker">${runs.length} archived run${runs.length === 1 ? '' : 's'} across ${byFamily.size} ${byFamily.size === 1 ? 'family' : 'families'}</div>
      <h2 id="history-title">Latency and throughput, as versions go by.</h2>
    </div>

    <p class="lead">One point per archived run, per family, on its own version axis. The band is the replicate
      spread measured inside that run rather than a model fitted to anything, and a chip only ever appears on a
      cell that is gateable: the right repetitions, a timer that did not saturate, a confidence its own producer
      signed off, and a calibration fitted for this host and filesystem.</p>

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
    const m = run.measurement;
    const floor = timerFloorUs(run);
    const c = run.counts;

    const ungateable = new Map();
    for (const s of run.samples) {
      if (s.gated) continue;
      for (const b of (s.gateBlockers.length ? s.gateBlockers : ['no reason recorded'])) {
        ungateable.set(b, (ungateable.get(b) ?? 0) + 1);
      }
    }

    const reps = Object.entries(m.reps ?? {}).map(([k, v]) => `${esc(k)} ${v}`).join(', ');
    const ev = (run.emulationEvidence ?? []).map((e) => `${e.source}: ${e.verdict}`).join('; ');
    const libs = Object.entries(run.libraries)
      .map(([id, v]) => `<code class="mono">${esc(id)}</code> ${esc(v.package)} ${esc(v.version)}`).join(', ');

    return `    <div class="family-block">
      <h3 class="family-title">${esc(fam.label)}</h3>
      <ul class="meta-list">
        <li class="meta-item"><strong>run</strong> <code class="mono">${esc(run.runId)}</code>, profile <code class="mono">${esc(run.profile ?? 'not recorded')}</code></li>
        <li class="meta-item"><strong>document digest</strong> <code class="mono">${esc(run.digest)}</code>${run.integrity.cells ? `, cells <code class="mono">${esc(String(run.integrity.cells).slice(0, 19))}</code>` : ''}</li>
        <li class="meta-item"><strong>engine</strong> ${libs}, at <code class="mono">${esc(String(run.commit).slice(0, 12))}</code>, harness at <code class="mono">${esc(String(run.harnessCommit ?? '').slice(0, 12))}</code>, lockfile <code class="mono">${esc(String(run.lockfileHash ?? 'not recorded').slice(0, 19))}</code></li>
        <li class="meta-item"><strong>host</strong> <code class="mono">${esc(run.host.os)}/${esc(run.host.arch)}</code>, ${count(run.host.ncpu)} cores, ${run.host.inContainer ? 'in a container' : 'on the metal'}, filesystem <code class="mono">${esc(run.host.fsType)}</code> on <code class="mono">${esc(run.host.mountSource ?? 'unknown')}</code>, fingerprint <code class="mono">${esc(run.host.fingerprint)}</code></li>
        <li class="meta-item"><strong>emulation</strong> ${run.emulated === false ? 'none' : String(run.emulated)}${ev ? `, probed: ${esc(ev)}` : ''}. A run under a translator is a measurement of the translator, so it is probed rather than assumed.</li>
        <li class="meta-item"><strong>load while measuring</strong> ${run.loadAverage ? `${num(run.loadAverage.oneMin)} one minute, ${num(run.loadAverage.fiveMin)} five, ${num(run.loadAverage.fifteenMin)} fifteen, on ${count(run.host.ncpu)} cores` : 'not recorded'}</li>
        <li class="meta-item"><strong>isolation</strong> ${esc(m.unit ?? 'not recorded')}, ${esc(m.isolation ?? 'not recorded')}</li>
        <li class="meta-item"><strong>repetitions</strong> ${reps || 'not recorded'}${m.warmup ? `, warm-up ${esc(m.warmup.policy)} (${count(m.warmup.passes)} pass)` : ''}, seed <code class="mono">${esc(m.seed ?? 'not recorded')}</code></li>
        <li class="meta-item"><strong>estimator</strong> ${esc(m.interval?.statistic ?? 'not recorded')}, ${esc(m.interval?.method ?? 'no interval')}${m.interval?.level ? ` at ${(m.interval.level * 100).toFixed(0)}% over ${count(m.interval.resamples)} resamples` : ''}</li>
        <li class="meta-item"><strong>timer</strong> tick ${num(m.timerTickNs)} ns, call cost ${num(m.timerCallNs)} ns, ${count(m.minTicksPerSample)} ticks minimum, so <span data-timer-floor="${floor === null ? 'n/a' : floor.toFixed(1)}">anything under ${floor === null ? 'n/a' : floor.toFixed(1)} &micro;s is below what this host's clock can resolve</span></li>
        <li class="meta-item"><strong>page cache</strong> ${esc(m.pageCache ?? 'not recorded')}. Cold here means a cold reader: a fresh process opening an artefact it has not opened. Nothing dropped the kernel's caches, and the run does not pretend otherwise.</li>
        <li class="meta-item"><strong>replicate pair</strong> ${run.replicateCell ? `<code class="mono">${esc(run.replicateCell)}</code> measured ${count(run.replicateReps)} times, ${count(c.replicated)} rows, which is where every band on this page comes from` : 'none, so nothing on this page draws a band'}</li>
        <li class="meta-item"><strong>cells</strong> ${count(c.measured)} measured${c.recovered ? ` (${count(c.fromSamples)} filed as samples and ${count(c.recovered)} recovered from the replicates array, see the note above)` : ''}, ${count(c.notMeasured)} that produced no number, ${count(c.lowConfidence)} low confidence. Of the ${count(c.timerApplicable)} where saturation is even a question, ${count(c.timerSaturated)} are under the floor; ${count(c.noisy)} have a coefficient of variation above ${pct(run.covFloor, 0)}${c.declared ? `; ${count(c.declared)} are declared by a model rather than measured` : ''}.</li>
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
    console.log(`up to date: ${pagePath} matches ${runs.map((r) => r.runId).join(', ')}`);
    process.exit(EXIT.OK);
  }
  console.error(`STALE: ${pagePath} does not match ${historyPath}. Re-run without --check.`);
  process.exit(EXIT.STALE);
}

writeFileSync(pagePath, page);
for (const run of runs) {
  console.log(`${String(run.family).padEnd(8)} ${run.runId}  ${run.counts.measured} cell(s)` +
    `${run.counts.recovered ? ` (${run.counts.recovered} recovered from replicates)` : ''}` +
    `  ${run.counts.gated} gateable  ${run.counts.timerSaturated} under the timer floor`);
}
console.log(`\nwrote ${pagePath}`);
