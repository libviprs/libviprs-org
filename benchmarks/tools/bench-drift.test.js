#!/usr/bin/env node
/* libviprs-org/benchmarks/tools/bench-drift.test.js
 *
 * Proves benchmarks/tools/bench-drift.js can fail.
 *
 * A gate that cannot fail is not a gate, and a parity check is the easiest
 * kind to get wrong that way: a regex that quietly matches nothing compares
 * zero cells and reports success. So every drift this check is supposed to
 * catch gets injected here, one at a time, into an in-memory copy of the page
 * and the data, and the check has to notice. The repo is never touched.
 *
 * The drifts below are not invented. Each of the first six is a class that
 * actually reached main during an unattended period: three stale engine
 * labels, two stale rounded megapixel figures, and one structural drift where
 * the static markup wrapped a column in <code> and the JSON entry did not.
 *
 * There is also a migration control at the end. "The pending markers clear
 * themselves once the numbers land" is easy to write into a comment and easy
 * to be wrong about, so it is done rather than claimed: real-shaped rows go
 * into the storage export, and the render has to drop the markers, drop the
 * row-pending class, print the numbers and hide the note, with the static
 * fallback then correctly reported as drifted because it still says pending.
 *
 * Usage:
 *   node benchmarks/tools/bench-drift.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const drift = require('./bench-drift.js');
const M = require('../js/scalability-tables.js');

const ROOT = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'benchmarks', 'index.html'), 'utf8');
const DATA = path.join(ROOT, 'benchmarks', 'data');
const SCENARIOS = JSON.parse(fs.readFileSync(path.join(DATA, 'engine-scenarios.json'), 'utf8'));
const SCALABILITY = JSON.parse(fs.readFileSync(path.join(DATA, 'scalability_results.json'), 'utf8'));
const PMTILES = JSON.parse(fs.readFileSync(path.join(DATA, 'pmtiles_results.json'), 'utf8'));

let passed = 0;
let failed = 0;

function ok(label, cond, detail) {
  if (cond) { passed += 1; console.log('  OK    ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

/* Inject one drift and assert the check reports it. `mutate` returns the
 * overrides to hand to check(). `wants` is a substring the finding list must
 * mention, so a test cannot pass on some unrelated failure. */
function catches(label, overrides, wants) {
  const findings = drift.check(overrides);
  const hit = findings.some(function (f) { return f.indexOf(wants) !== -1; });
  ok(label, findings.length > 0 && hit,
     findings.length === 0
       ? 'the check reported no drift at all'
       : 'findings did not mention ' + JSON.stringify(wants) + ':\n          ' + findings.join('\n          '));
}

function replaceOnce(s, from, to) {
  const i = s.indexOf(from);
  if (i === -1) throw new Error('fixture text not found: ' + JSON.stringify(from));
  if (s.indexOf(from, i + 1) !== -1) throw new Error('fixture text is not unique: ' + JSON.stringify(from));
  return s.slice(0, i) + to + s.slice(i + from.length);
}

/* Same, but for text the pending fixture repeats once per row: change only the
 * first occurrence, so exactly one row drifts and the rest stay as the control. */
function replaceFirst(s, from, to) {
  const i = s.indexOf(from);
  if (i === -1) throw new Error('fixture text not found: ' + JSON.stringify(from));
  return s.slice(0, i) + to + s.slice(i + from.length);
}

/* The storage table is measured today and was pending yesterday, and the gate
 * has to work in both states, so the pending fixtures are derived from the
 * renderer rather than copied out of whatever the page happens to say this
 * week. Entities are not re-encoded here on purpose: norm() decodes them, so a
 * literal em dash and &mdash; are the same fixture. */
function storageTbodyFor(exportDoc) {
  const model = M.storageTableModel(M.readStorageRows(exportDoc), SCENARIOS, true);
  return model.rows.map(function (r) {
    const cells = r.cells.map(function (c) {
      return c.scope === 'row'
        ? '          <th scope="row">' + c.html + '</th>'
        : '          <td>' + c.html + '</td>';
    }).join('\n');
    return '        <tr' + (r.pending ? ' class="row-pending"' : '') + '>\n' + cells + '\n        </tr>';
  }).join('\n');
}

/* The committed page with its storage table swapped for the one `exportDoc`
 * renders, note visibility included. */
function pageWith(html, exportDoc) {
  const model = M.storageTableModel(M.readStorageRows(exportDoc), SCENARIOS, true);
  const tbl = /(<table[^>]*data-bench-table="storage"[^>]*>)([\s\S]*?)(<\/table>)/.exec(html);
  if (!tbl) throw new Error('no storage table in the fixture page');
  const swapped = tbl[2].replace(/(<tbody[^>]*>\n)[\s\S]*?(      <\/tbody>)/,
    '$1' + storageTbodyFor(exportDoc).replace(/\$/g, '$$$$') + '\n$2');
  let out = html.replace(tbl[2], swapped);
  out = model.pendingCount > 0
    ? out.replace('data-bench-note="storage" hidden>', 'data-bench-note="storage">')
    : out.replace(/data-bench-note="storage"(?! hidden)>/, 'data-bench-note="storage" hidden>');
  return out;
}

// The export that has every row pending: the shape this page shipped with
// before libviprs/libviprs#993 published its measurements.
const EMPTY_EXPORT = { schema: 1, rows: [] };
const PENDING_PAGE = pageWith(HTML, EMPTY_EXPORT);

console.log('[0] NEGATIVE CONTROL: the committed tree is clean');
{
  const findings = drift.check();
  ok('the committed page and data agree, with no overrides', findings.length === 0,
     findings.join('\n          '));
  // If the parser silently matched nothing, [0] would pass for the wrong
  // reason, so count what it actually found.
  const tables = drift.extractTables(HTML);
  const notes = drift.extractNotes(HTML);
  const cells = Object.keys(tables).reduce(function (n, k) {
    return n + tables[k].rows.reduce(function (m, r) { return m + r.cells.length; }, 0);
  }, 0);
  ok('the parser found all three tables', Object.keys(tables).sort().join(',') === 'engines,scenarios,storage',
     Object.keys(tables).join(','));
  ok('the parser found a non-trivial number of static cells (' + cells + ')', cells >= 80, String(cells));
  ok('the parser found the storage note', !!notes.storage);
}

console.log('\n[1] the six drift classes that actually reached main');
catches('a stale engine label in the scenario fallback',
  { html: replaceOnce(HTML, '<span class="engine-swatch swatch-mono"></span>libviprs monolithic</span></td>',
                            '<span class="engine-swatch swatch-mono"></span>Monolithic</span></td>') },
  'Monolithic');

catches('a stale rounded figure in the engine caption',
  { html: replaceOnce(HTML, 'Engine comparison at 8192&times;5760 (47.2 MP)',
                            'Engine comparison at 8192&times;5760 (47 MP)') },
  'caption');

catches('a stale rounded figure in a scenario speed cell',
  { html: replaceOnce(HTML, '2,944&nbsp;tiles/s at 47.2&nbsp;MP',
                            '2,944&nbsp;tiles/s at 47&nbsp;MP') },
  'scenarios');

catches('a <code> wrapper in the markup that the JSON entry does not carry',
  { html: replaceOnce(HTML, '<td><code>O(canvas&sup2;)</code></td>',
                            '<td>O(canvas&sup2;)</td>') },
  '<code>');

catches('a wrong swatch class',
  { html: replaceOnce(HTML, 'swatch-stream"></span>libviprs streaming</span></th>',
                            'swatch-mr"></span>libviprs streaming</span></th>') },
  'swatch-mr');

catches('a wrong number in a data cell',
  { html: replaceOnce(HTML, '<td>2,028</td>', '<td>2,082</td>') },
  '2,082');

console.log('\n[2] the pending machinery, which has to stay gateable now that the numbers landed');
{
  // A second negative control: the pending state is internally consistent too,
  // so every finding below is the injected drift and not the fixture.
  const clean = drift.check({ html: PENDING_PAGE, pmtiles: EMPTY_EXPORT });
  ok('the pending page and the empty export agree', clean.length === 0, clean.join('\n          '));
  const pendingRows = drift.extractTables(PENDING_PAGE).storage.rows;
  ok('the pending fixture really is pending (8 rows, all marked)',
     pendingRows.length === 8 && pendingRows.every(function (r) { return r.pending; }));
}

catches('a pending row that lost its row-pending class',
  { html: replaceFirst(PENDING_PAGE, '<tr class="row-pending">', '<tr>'),
    pmtiles: EMPTY_EXPORT },
  'row-pending');

catches('a pending row whose marker was dropped from the markup',
  { html: replaceFirst(PENDING_PAGE,
      'PMTiles archive<sup class="bench-pending" title="Measurements pending; see the note under this table.">\u2020</sup>',
      'PMTiles archive'),
    pmtiles: EMPTY_EXPORT },
  'storage');

catches('a marker pointing at a note that does not exist',
  { html: PENDING_PAGE.replace(/<p class="bench-note" data-bench-note="storage"[^>]*>[\s\S]*?<\/p>\n/, ''),
    pmtiles: EMPTY_EXPORT },
  'no [data-bench-note="storage"] element');

catches('a note whose text drifted away from the JSON',
  { html: replaceOnce(PENDING_PAGE, 'The storage measurements are pending.', 'The storage measurements are on their way.'),
    pmtiles: EMPTY_EXPORT },
  'note text');

catches('a note hidden while rows are still pending',
  { html: replaceOnce(PENDING_PAGE, 'data-bench-note="storage">', 'data-bench-note="storage" hidden>'),
    pmtiles: EMPTY_EXPORT },
  'hidden while rows are still pending');

catches('a note left visible once nothing is pending',
  { html: replaceOnce(HTML, 'data-bench-note="storage" hidden>', 'data-bench-note="storage">') },
  'the static note is visible');

catches('a measured page left standing against a pending export',
  { pmtiles: EMPTY_EXPORT },
  'row-pending');

catches('a pending page left standing against a measured export',
  { html: PENDING_PAGE },
  'row-pending');

console.log('\n[3] the storage export contract');
{
  const findings = drift.check({ pmtiles: { schema: 2, rows: [] } });
  ok('an unknown schema is refused rather than rendered',
     findings.length === 1 && /schema 2/.test(findings[0]), findings.join(' | '));
}
{
  const findings = drift.check({ pmtiles: [] });
  ok('a bare array (the pre-envelope shape) is refused',
     findings.length === 1 && /envelope/.test(findings[0]), findings.join(' | '));
}
{
  const findings = drift.check({ pmtiles: { schema: 1, rows: {} } });
  ok('an envelope whose rows are not an array is refused',
     findings.length === 1 && /rows/.test(findings[0]), findings.join(' | '));
}

console.log('\n[4] row identity: a read row must never answer for a generation column');
function measured(o) {
  return Object.assign({
    width: 8192, height: 8192, tile_size: 64, megapixels: 67.108864,
    engine: 'mapreduce', storage: 'pmtiles', scenario: 'generate', concurrency: 1,
    wall_time_ms: 1684.03, tracked_memory_mb: 12.0, peak_rss_mb: 120.5,
    tiles_produced: 21851, tiles_per_second: 12975.4, tiles_per_second_per_mb: 107.7,
    resource_cost: 0.0092, output_bytes: 133758824, filesystem_entries: 1,
    tile_bytes_returned: null, p50_latency_us: null, p99_latency_us: null,
  }, o);
}
{
  const gen = measured({ scenario: 'generate', wall_time_ms: 1684.03, tiles_produced: 21851 });
  const read = measured({ scenario: 'read_random', wall_time_ms: 24.9, tiles_produced: 20000,
                          p50_latency_us: 1.21, p99_latency_us: 1.96 });
  // The read row is deliberately listed FIRST, which is what a first-match
  // lookup keyed only on (engine, megapixels) would have returned.
  const rows = [read, gen];
  const genHit = M.findStorageRow(rows, { storage: 'pmtiles', width: 8192, height: 8192, tile_size: 64, scenario: 'generate', concurrency: 1 });
  const readHit = M.findStorageRow(rows, { storage: 'pmtiles', width: 8192, height: 8192, tile_size: 64, scenario: 'read_random', concurrency: 1 });
  ok('the generation column reads the generation row, not the first match',
     genHit && genHit.wall_time_ms === 1684.03, JSON.stringify(genHit && genHit.wall_time_ms));
  ok('the latency column reads the read row', readHit && readHit.p50_latency_us === 1.21);
  ok('a row at the same size but the other tile size does not match',
     M.findStorageRow(rows, { storage: 'pmtiles', width: 8192, height: 8192, tile_size: 256, scenario: 'generate', concurrency: 1 }) === null);
  ok('a row of the other storage backend does not match',
     M.findStorageRow(rows, { storage: 'directory', width: 8192, height: 8192, tile_size: 64, scenario: 'generate', concurrency: 1 }) === null);
  ok('an ambiguous key returns nothing rather than guessing',
     M.findStorageRow([gen, gen], { storage: 'pmtiles', width: 8192, height: 8192, tile_size: 64, scenario: 'generate', concurrency: 1 }) === null);
}

console.log('\n[5] a null is an em dash and never a zero');
{
  ok('fmt(null) is the em dash', M.fmt(null, { format: 'int' }) === '—');
  ok('fmt(null, fixed2) is the em dash too', M.fmt(null, { format: 'fixed2' }) === '—');
  ok('a real zero still prints as zero unless the column opts out',
     M.fmt(0, { format: 'int' }) === '0' && M.fmt(0, { format: 'int', zero_as_dash: true }) === '—');
  const cfg = clone(SCENARIOS);
  cfg.storage_table.rows = [{ width: 8192, height: 8192, tile_size: 64, storage: 'pmtiles' }];
  const half = M.storageTableModel([measured({})], cfg, true);
  const texts = half.rows[0].cells.map(function (c) { return c.html; });
  ok('a row with some nulls is not pending, and the null cells are em dashes',
     half.pendingCount === 0 && texts.indexOf('—') !== -1, texts.join(' | '));
}

console.log('\n[6] MIGRATION CONTROL: the numbers landing clears everything by itself');
{
  const cfg = clone(SCENARIOS);
  cfg.storage_table.rows = [
    { width: 8192, height: 8192, tile_size: 64, storage: 'pmtiles' },
    { width: 8192, height: 8192, tile_size: 64, storage: 'directory' },
  ];
  // Every scenario a column names, or the fixture leaves a hole and the control
  // fails for its own reasons rather than the renderer's.
  const rows = [
    measured({ storage: 'pmtiles',   scenario: 'generate',    filesystem_entries: 1,     wall_time_ms: 1684.03 }),
    measured({ storage: 'pmtiles',   scenario: 'read_cold',   p50_latency_us: 69.13, p99_latency_us: 103.58 }),
    measured({ storage: 'pmtiles',   scenario: 'read_random', p50_latency_us: 1.21,  p99_latency_us: 1.96 }),
    measured({ storage: 'directory', scenario: 'generate',    filesystem_entries: 22127, wall_time_ms: 1667.62, output_bytes: 133748027 }),
    measured({ storage: 'directory', scenario: 'read_cold',   p50_latency_us: 2.96,  p99_latency_us: 8.75 }),
    measured({ storage: 'directory', scenario: 'read_random', p50_latency_us: 3.42,  p99_latency_us: 4.46 }),
  ];
  const model = M.storageTableModel(rows, cfg, true);
  const flat = model.rows.map(function (r) { return r.cells.map(function (c) { return c.html; }).join(' | '); });

  ok('nothing is pending any more', model.pendingCount === 0, String(model.pendingCount));
  ok('no row carries the row-pending class', model.rows.every(function (r) { return !r.pending; }));
  ok('no marker is rendered', flat.every(function (r) { return r.indexOf('bench-pending') === -1; }));
  ok('no cell is left as an em dash', flat.every(function (r) { return r.indexOf('—') === -1; }), flat.join('\n          '));
  ok('the archive reports one filesystem entry', flat[0].indexOf('| 1 |') !== -1, flat[0]);
  ok('the tree reports 22,127 for the same 21,851 tiles',
     flat[1].indexOf('22,127') !== -1 && flat[1].indexOf('21,851') !== -1, flat[1]);
  ok('the latency columns are filled from the read rows, not the generation rows',
     flat[0].indexOf('1.21') !== -1 && flat[1].indexOf('3.42') !== -1, flat[0] + ' / ' + flat[1]);
  ok('the cold column reads read_cold and not read_random',
     flat[0].indexOf('69.13') !== -1 && flat[1].indexOf('2.96') !== -1, flat[0] + ' / ' + flat[1]);
  ok('the note would hide itself', model.pendingCount === 0);
}

console.log('\n[7] entity spelling and line wrapping are not drift');
{
  const findings = drift.check({
    html: HTML
      .replace(/&mdash;/g, '—')
      .replace(/&nbsp;/g, ' ')
      .replace(/&times;/g, '×'),
  });
  ok('rewriting entities as literal characters reports nothing', findings.length === 0,
     findings.join('\n          '));
}

console.log('\n[8] the committed export, read exactly the way the page reads it');
{
  const rows = M.readStorageRows(PMTILES);
  const cfg = SCENARIOS.storage_table;

  // p50 and p99 are null on every generation row by design. The table must
  // never reach one: its latency columns name read_random, and a generation
  // column names generate, so the two can't cross.
  const gens = rows.filter(function (r) { return r.scenario === 'generate'; });
  ok('every generation row carries a null p50 and p99',
     gens.length > 0 && gens.every(function (r) { return r.p50_latency_us === null && r.p99_latency_us === null; }));

  let latencyLookups = 0, hitGenerate = 0, unresolved = 0;
  cfg.rows.forEach(function (spec) {
    cfg.columns.filter(function (c) { return /_latency_us$/.test(c.key); }).forEach(function (c) {
      latencyLookups += 1;
      const hit = M.findStorageRow(rows, {
        storage: spec.storage, width: spec.width, height: spec.height,
        tile_size: spec.tile_size, scenario: c.scenario, concurrency: c.concurrency });
      if (!hit) { unresolved += 1; return; }
      if (hit.scenario === 'generate') hitGenerate += 1;
    });
  });
  ok('no latency column ever resolves to a generation row',
     hitGenerate === 0 && unresolved === 0,
     'lookups ' + latencyLookups + ', generate hits ' + hitGenerate + ', unresolved ' + unresolved);

  // Nothing in the export is a flattering zero, and nothing rendered is one
  // either: a null would have printed as an em dash, which is now absent.
  const zeroed = rows.filter(function (r) {
    return Object.keys(r).some(function (k) { return typeof r[k] === 'number' && r[k] === 0; });
  });
  ok('no field in the export holds 0', zeroed.length === 0, String(zeroed.length));

  const model = M.storageTableModel(rows, SCENARIOS, true);
  const cells = model.rows.reduce(function (a, r) { return a.concat(r.cells.map(function (c) { return c.html; })); }, []);
  ok('nothing renders as an em dash', cells.indexOf('\u2014') === -1);
  ok('nothing renders as a bare 0 or 0.00',
     cells.indexOf('0') === -1 && cells.indexOf('0.00') === -1);
  ok('a null in a latency column would still be an em dash, never 0.00',
     M.fmt(null, { key: 'p99_latency_us', format: 'fixed2' }) === '\u2014');

  // The cell the whole table exists for.
  const leafy = { width: 8192, height: 8192, tile_size: 64 };
  const arc = M.findStorageRow(rows, Object.assign({ storage: 'pmtiles', scenario: 'generate', concurrency: 1 }, leafy));
  const tree = M.findStorageRow(rows, Object.assign({ storage: 'directory', scenario: 'generate', concurrency: 1 }, leafy));
  ok('21,851 tiles is 1 filesystem entry as an archive and 22,127 as a tree',
     arc.tiles_produced === 21851 && arc.filesystem_entries === 1 &&
     tree.tiles_produced === 21851 && tree.filesystem_entries === 22127,
     arc.filesystem_entries + ' vs ' + tree.filesystem_entries);
  ok('the archive is the smaller write on that cell, 1034 ms against 1183',
     arc.wall_time_ms < tree.wall_time_ms,
     arc.wall_time_ms.toFixed(2) + ' vs ' + tree.wall_time_ms.toFixed(2));
  const arcR = M.findStorageRow(rows, Object.assign({ storage: 'pmtiles', scenario: 'read_random', concurrency: 1 }, leafy));
  const treeR = M.findStorageRow(rows, Object.assign({ storage: 'directory', scenario: 'read_random', concurrency: 1 }, leafy));
  ok('and answers a random read in 1.00 us against 3.17',
     M.fmt(arcR.p50_latency_us, { format: 'fixed2' }) === '1.00' &&
     M.fmt(treeR.p50_latency_us, { format: 'fixed2' }) === '3.17');

  // The cold-read column is the one a tile tree wins, which is why it is a
  // column. It has to come off read_cold and nothing else, on every row.
  const coldCol = cfg.columns.filter(function (c) { return c.scenario === 'read_cold'; });
  ok('there is exactly one cold-read column and it reads p50', coldCol.length === 1 && coldCol[0].key === 'p50_latency_us');
  let coldHits = 0, coldWrongScenario = 0, coldNull = 0;
  cfg.rows.forEach(function (spec) {
    const hit = M.findStorageRow(rows, {
      storage: spec.storage, width: spec.width, height: spec.height,
      tile_size: spec.tile_size, scenario: 'read_cold', concurrency: 1 });
    if (!hit) return;
    coldHits += 1;
    if (hit.scenario !== 'read_cold') coldWrongScenario += 1;
    if (hit.p50_latency_us == null) coldNull += 1;
  });
  ok('every configured row has a cold-read measurement',
     coldHits === cfg.rows.length && coldWrongScenario === 0 && coldNull === 0,
     'hits ' + coldHits + '/' + cfg.rows.length + ', wrong scenario ' + coldWrongScenario + ', null ' + coldNull);
  const arcC = M.findStorageRow(rows, Object.assign({ storage: 'pmtiles', scenario: 'read_cold', concurrency: 1 }, leafy));
  const treeC = M.findStorageRow(rows, Object.assign({ storage: 'directory', scenario: 'read_cold', concurrency: 1 }, leafy));
  ok('the tree wins the cold read, 2.96 us against the archive\'s 69.13',
     treeC.p50_latency_us < arcC.p50_latency_us &&
     M.fmt(arcC.p50_latency_us, { format: 'fixed2' }) === '69.13' &&
     M.fmt(treeC.p50_latency_us, { format: 'fixed2' }) === '2.96');
  ok('a null cold read would render as an em dash, never 0.00',
     M.fmt(null, coldCol[0]) === '\u2014' && M.fmt(0, coldCol[0]) === '0.00');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
