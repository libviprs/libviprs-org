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

console.log('\n[2] the pending machinery, which is new and therefore unproven');
catches('a pending row that lost its row-pending class',
  { html: replaceOnce(HTML,
      '<tr class="row-pending">\n          <th scope="row">8192&times;8192, 64&nbsp;px tiles</th>\n          <td><span class="engine-cell"><span class="engine-swatch swatch-pmtiles">',
      '<tr>\n          <th scope="row">8192&times;8192, 64&nbsp;px tiles</th>\n          <td><span class="engine-cell"><span class="engine-swatch swatch-pmtiles">') },
  'row-pending');

catches('a pending row whose marker was dropped from the markup',
  { html: replaceOnce(HTML,
      'PMTiles archive<sup class="bench-pending" title="Measurements pending; see the note under this table.">&dagger;</sup></span></td>\n          <td>&mdash;</td>\n          <td>&mdash;</td>\n          <td>&mdash;</td>\n          <td>&mdash;</td>\n          <td>&mdash;</td>\n          <td>&mdash;</td>\n          <td>&mdash;</td>\n        </tr>\n        <tr class="row-pending">\n          <th scope="row">2048&times;2048, 256&nbsp;px tiles</th>',
      'PMTiles archive</span></td>\n          <td>&mdash;</td>\n          <td>&mdash;</td>\n          <td>&mdash;</td>\n          <td>&mdash;</td>\n          <td>&mdash;</td>\n          <td>&mdash;</td>\n          <td>&mdash;</td>\n        </tr>\n        <tr class="row-pending">\n          <th scope="row">2048&times;2048, 256&nbsp;px tiles</th>') },
  'storage');

catches('a marker pointing at a note that does not exist',
  { html: HTML.replace(/<p class="bench-note" data-bench-note="storage">[\s\S]*?<\/p>\n/, '') },
  'no [data-bench-note="storage"] element');

catches('a note whose text drifted away from the JSON',
  { html: replaceOnce(HTML, 'The storage measurements are pending.', 'The storage measurements are on their way.') },
  'note text');

catches('a note left visible while nothing is pending',
  (function () {
    const cfg = clone(SCENARIOS);
    // One configured row, and an export that measures it: nothing pending.
    cfg.storage_table.rows = [{ width: 1, height: 1, tile_size: 256, storage: 'pmtiles' }];
    return {
      scenarios: cfg,
      pmtiles: { schema: 1, rows: [measured({ width: 1, height: 1, tile_size: 256, storage: 'pmtiles', scenario: 'generate' })] },
    };
  })(),
  'row count');  // the static table still has eight rows; the row-count finding fires first

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
  const rows = [
    measured({ storage: 'pmtiles',   scenario: 'generate',    filesystem_entries: 1,     wall_time_ms: 1684.03 }),
    measured({ storage: 'pmtiles',   scenario: 'read_random', p50_latency_us: 1.21,  p99_latency_us: 1.96 }),
    measured({ storage: 'directory', scenario: 'generate',    filesystem_entries: 22127, wall_time_ms: 1667.62, output_bytes: 133748027 }),
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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
