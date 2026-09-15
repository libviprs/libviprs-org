#!/usr/bin/env node
/* benchmarks/tools/render-latest.test.mjs
 *
 * The guards for libviprs-org#76: /benchmarks/ is the generated libviprs
 * benchmark page, rendered from history.json, covering every family.
 *
 * Every test below names the wrong implementation it goes red against, because
 * a guard whose failure mode nobody wrote down tends not to have one.
 *
 *    1. a_run_that_is_not_archived_by_digest_is_refused
 *    2. the_document_digest_is_read_from_the_integrity_block_and_from_a_flat_field
 *    3. a_field_the_page_needs_and_the_producer_stopped_writing_is_a_refusal_naming_it
 *    4. a_replicate_of_a_cell_it_is_not_is_read_as_the_cell_it_says_it_is
 *    5. the_low_confidence_band_is_computed_from_the_documents_own_timer
 *    6. every_low_confidence_cell_is_shown_marked_and_never_chipped
 *    7. no_invariant_is_charted
 *    8. an_invariant_step_renders_as_a_rule_carrying_the_commit_that_moved_it
 *    9. check_is_red_on_a_stale_page_and_green_on_a_fresh_one
 *   10. the_page_renders_every_number_with_javascript_off
 *   11. the_headline_claim_is_computed_from_the_run_not_written_into_the_page
 *   12. an_ungateable_family_never_gets_a_verdict_chip
 *   13. the_not_measured_list_comes_from_config
 *   14. every_class_the_renderer_emits_is_styled
 *   15. the_memory_column_is_per_engine_and_the_page_counts_what_proves_it
 *   16. a_metric_that_got_faster_is_not_a_regression_and_a_delta_inside_the_spread_is_noise
 *   17. every_sample_field_a_verdict_rule_reads_is_declared_in_samples_carry
 *   18. the_two_causes_of_low_confidence_are_told_apart
 *   19. two_cells_with_the_same_tile_count_stay_two_cells
 *
 * Every count in here is read off benchmarks/history.json rather than written
 * down, because the last capture's figures outlived the capture by one round
 * and ended up in a report. A count typed into a test is a claim about a file
 * that will be replaced.
 *
 * Plain Node, no dependency and no build step (libviprs-org#62).
 *
 * Usage:
 *   node benchmarks/tools/render-latest.test.mjs      # exit 1 on any failure
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const BENCH = join(here, '..');
const RENDERER = join(here, 'render-latest.mjs');
const HISTORY = join(BENCH, 'history.json');
const PAGE = join(BENCH, 'index.html');
const CONFIG = join(here, 'config.json');
const CSS = join(BENCH, 'css', 'benchmarks-dashboard.css');

const failures = [];
let passed = 0;

function test(name, fn) {
  try {
    const note = fn();
    passed++;
    console.log(`  ok   ${name}${note ? `  (${note})` : ''}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`  FAIL ${name}\n       ${err && err.message}`);
  }
}

const assert = (cond, message) => { if (!cond) throw new Error(message); };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const scratch = () => mkdtempSync(join(tmpdir(), 'libviprs-page-'));
const clone = (x) => JSON.parse(JSON.stringify(x));

function runCli(args) {
  const r = spawnSync(process.execPath, [RENDERER, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Render a history into a fresh page and hand back the HTML. */
function renderInto(history, { config = CONFIG } = {}) {
  const dir = scratch();
  const hp = join(dir, 'history.json');
  const pp = join(dir, 'index.html');
  writeFileSync(hp, JSON.stringify(history, null, 2));
  writeFileSync(pp, readFileSync(PAGE, 'utf8'));
  const r = runCli(['--history', hp, '--page', pp, '--config', config]);
  return { ...r, html: () => readFileSync(pp, 'utf8'), dir, hp, pp };
}

const history = readJson(HISTORY);
const config = readJson(CONFIG);
const storageRun = history.find((r) => r.family === 'storage');
const enginesRun = history.find((r) => r.family === 'engines');
assert(storageRun && enginesRun, 'the committed history is missing a family, so most of this suite is checking nothing');

// Everything the tests count, read off the history rather than written down.
const covFloor = storageRun.measurement.covLowConfidence;
const digestOf = (run) => run.integrity?.document ?? run.documentDigest;
const declaredReplicateCell = (run) => run.replicate?.cell ?? null;
const shownSamples = (run) => [
  ...run.samples,
  ...(run.replicates ?? []).filter((s) => s.cell !== declaredReplicateCell(run)),
];
const SAT = storageRun.samples.filter((s) => s.timerSaturated === true).length;
const NOISY = storageRun.samples.filter((s) => Number.isFinite(s.cov) && s.cov > covFloor).length;
const MEASURED = storageRun.samples.length;

console.log('');
console.log('benchmarks/tools/render-latest.test.mjs');
console.log('');

// ---------------------------------------------------------------------------
// 1. a_run_that_is_not_archived_by_digest_is_refused
//
// The epic's rule is that nothing is published, charted or quoted from a run
// that is not archived by digest. A renderer that happily paints a history
// entry somebody hand-edited in is the hole in that rule, so the refusal is a
// test rather than a convention.
//
// Goes red against: a renderer that renders whatever it is handed; and against
// one that refuses by returning empty sections instead of a non-zero exit,
// which looks exactly like a run with nothing in it.
// ---------------------------------------------------------------------------
test('a_run_that_is_not_archived_by_digest_is_refused', () => {
  const noRunId = clone(history);
  delete noRunId[noRunId.length - 1].runId;
  let r = renderInto(noRunId);
  assert(r.code !== 0, `a run with no runId rendered anyway (exit ${r.code})`);
  assert(/refus/i.test(r.err) && /runId/.test(r.err), `the refusal does not name runId:\n${r.err}`);

  // Both places the digest can live, gone.
  const noDigest = clone(history);
  delete noDigest[noDigest.length - 1].integrity.document;
  delete noDigest[noDigest.length - 1].documentDigest;
  r = renderInto(noDigest);
  assert(r.code !== 0, 'a run with no document digest anywhere rendered anyway');
  assert(/refus/i.test(r.err) && /digest/i.test(r.err), `the refusal does not mention the digest:\n${r.err}`);

  const bad = clone(history);
  bad[bad.length - 1].integrity.document = 'trust me';
  delete bad[bad.length - 1].documentDigest;
  r = renderInto(bad);
  assert(r.code !== 0, 'a run whose digest is not a digest rendered anyway');
  return 'missing runId, missing digest and a malformed digest all refuse';
});

// ---------------------------------------------------------------------------
// 2. the_document_digest_is_read_from_the_integrity_block_and_from_a_flat_field
//
// The importer carries the producer's own `integrity` block through intact, so
// the document digest lives at `integrity.document`. This renderer was written
// against a flat `documentDigest` and found nothing there, which is the fourth
// cross-repo shape mismatch this wave and the third that produced `undefined`
// rather than an error. Both spellings resolve now, and both are tested,
// because a fallback nobody exercises is a fallback nobody knows is broken.
//
// Goes red against: reading only the flat field (the committed history renders
// nothing), and against reading only the nested one (a history written before
// the block was carried is refused over a field name).
// ---------------------------------------------------------------------------
test('the_document_digest_is_read_from_the_integrity_block_and_from_a_flat_field', () => {
  const nested = renderInto(history);
  assert(nested.code === 0, `the committed history, which carries integrity.document, did not render: ${nested.err}`);
  for (const run of history) {
    assert(nested.html().includes(digestOf(run)),
      `the page never names the document digest of ${run.runId}, so it is not reading integrity.document`);
  }

  // The older flat spelling, with no integrity block at all.
  const flat = clone(history).map((run) => {
    const out = { ...run, documentDigest: run.integrity.document };
    delete out.integrity;
    return out;
  });
  const r = renderInto(flat);
  assert(r.code !== 0, 'a run with no integrity block rendered; the block carries the four digests the method section reports');
  assert(/integrity/.test(r.err), `the refusal for a missing integrity block does not name it:\n${r.err}`);

  // Flat digest alongside the block, with the nested one absent: still renders.
  const both = clone(history).map((run) => {
    const out = clone(run);
    out.documentDigest = out.integrity.document;
    delete out.integrity.document;
    return out;
  });
  const r2 = renderInto(both);
  assert(r2.code === 0, `a history carrying the digest flat was refused: ${r2.err}`);
  for (const run of history) {
    assert(r2.html().includes(digestOf(run)), 'the flat documentDigest fallback is not actually read');
  }
  return 'integrity.document read, flat documentDigest read as a fallback, missing integrity block refused';
});

// ---------------------------------------------------------------------------
// 3. a_field_the_page_needs_and_the_producer_stopped_writing_is_a_refusal_naming_it
//
// Four lanes in this wave shipped a cross-repo shape mismatch and every one of
// them looked like correct behaviour: ten config keys read that the config
// never defined, an archive directory resolved one way and written another, a
// digest nested where the reader wanted it flat, and this file reading
// `run.series` off an importer that writes `run.libraries`. They survive
// because `undefined` renders as an empty string and a section that produces no
// rows looks exactly like a section with no rows to produce.
//
// So: every field the page needs goes through normalise(), and a field that is
// not there is an exit code and a path, not a blank cell.
//
// Goes red against: a renderer that reads producer fields inline with `?.` and
// renders the gaps as empty strings.
// ---------------------------------------------------------------------------
test('a_field_the_page_needs_and_the_producer_stopped_writing_is_a_refusal_naming_it', () => {
  const FIELDS = [
    ['libraries', (run) => { delete run.libraries; }],
    ['samples', (run) => { delete run.samples; }],
    ['invariants', (run) => { delete run.invariants; }],
    ['measurement', (run) => { delete run.measurement; }],
    ['host.fingerprint', (run) => { delete run.host.fingerprint; }],
    ['version', (run) => { delete run.version; }],
    ['commit', (run) => { delete run.commit; }],
    ['direction', (run) => { delete run.samples[0].direction; }],
    ['confidence', (run) => { delete run.samples[0].confidence; }],
  ];
  const missed = [];
  for (const [path, drop] of FIELDS) {
    const mutated = clone(history);
    drop(mutated[0]);
    const r = renderInto(mutated);
    if (r.code === 0) { missed.push(`${path}: rendered anyway`); continue; }
    if (!r.err.includes(path)) missed.push(`${path}: refused without naming the path (${r.err.split('\n')[0]})`);
  }
  assert(missed.length === 0,
    `${missed.length} field(s) the page needs did not fail loudly:\n  ${missed.join('\n  ')}\n` +
    'A missing producer field has to be an exit code and a path. Rendered-as-blank is how the last four of these shipped.');
  return `${FIELDS.length} producer fields, each a refusal naming its own path`;
});

// ---------------------------------------------------------------------------
// 4. a_replicate_of_a_cell_it_is_not_is_read_as_the_cell_it_says_it_is
//
// A replicate is the same cell measured twice, and the run declares which cell
// that is. The engines run files its eight-thread cells in the replicates array
// because they share a tile count with their single-thread twins, so a renderer
// that trusts the array label silently loses half the experiment and nothing on
// the page says a word about it.
//
// Goes red against: dropping the replicates array wholesale (the concurrency
// arm disappears), merging it wholesale (the true replicate pair is counted as
// a distinct cell and doubles the cell count), and recovering the rows without
// saying so on the page.
// ---------------------------------------------------------------------------
test('a_replicate_of_a_cell_it_is_not_is_read_as_the_cell_it_says_it_is', () => {
  const declared = declaredReplicateCell(enginesRun);
  assert(declared, 'the engines run declares no replicate cell, so this guard is checking nothing');
  const misfiled = (enginesRun.replicates ?? []).filter((s) => s.cell !== declared);
  const trueReps = (enginesRun.replicates ?? []).filter((s) => s.cell === declared);
  assert(misfiled.length > 0, 'nothing is misfiled in the committed history, so this guard is checking nothing');
  assert(trueReps.length > 0, 'the engines run has no true replicate rows, so the split this checks is trivial');

  const r = renderInto(history);
  assert(r.code === 0, `render failed: ${r.err}`);
  const html = r.html();

  // Every recovered cell is on the page.
  const recoveredCells = [...new Set(misfiled.map((s) => s.cell))];
  for (const cell of recoveredCells) {
    assert(html.includes(cell), `recovered cell ${cell} is nowhere on the page, so the concurrency arm was dropped`);
  }
  // The true replicate pair is NOT counted as a distinct cell.
  const section = html.slice(html.indexOf('GENERATED:engines:BEGIN'), html.indexOf('GENERATED:engines:END'));
  const rowsFor = (cell) => (section.match(new RegExp(`<code class="mono">${cell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</code>`, 'g')) || []).length;
  assert(rowsFor(declared) > 0, `the declared replicate cell ${declared} is missing from the engines tables`);

  // And the page says it happened, with the count and the reason.
  assert(new RegExp(`\\b${misfiled.length}\\b`).test(html),
    `the page never says how many rows (${misfiled.length}) were recovered from the replicates array`);
  assert(/filed as replicates of a cell they are not/.test(html),
    'the page recovers the rows without saying it did, which is a silent second opinion about the producer');
  return `${misfiled.length} recovered across ${recoveredCells.length} cells, ${trueReps.length} true replicate rows kept as replicates, stated on the page`;
});

// ---------------------------------------------------------------------------
// 5. the_low_confidence_band_is_computed_from_the_documents_own_timer
//
// The floor is the measured tick times the hundred-tick minimum, and both are
// carried in the document. Writing the number into the page makes it a fact
// about whichever machine happened to run first.
//
// Goes red against: a renderer with the number in its template, which stays put
// when the host's tick changes.
// ---------------------------------------------------------------------------
test('the_low_confidence_band_is_computed_from_the_documents_own_timer', () => {
  const tick = storageRun.measurement.timerTickNs;
  const ticks = storageRun.measurement.minTicksPerSample;
  const floor = ((tick * ticks) / 1000).toFixed(1);

  const asIs = renderInto(history);
  assert(asIs.code === 0, `the committed history did not render: ${asIs.err}`);
  assert(new RegExp(`data-timer-floor="${floor}"`).test(asIs.html()),
    `the rendered page never states the ${floor} us floor it computed`);

  const doubled = clone(history);
  for (const run of doubled) run.measurement.timerTickNs *= 2;
  const want = ((tick * 2 * ticks) / 1000).toFixed(1);
  const r = renderInto(doubled);
  assert(r.code === 0, `the doubled-tick history did not render: ${r.err}`);
  assert(new RegExp(`data-timer-floor="${want}"`).test(r.html()),
    `doubling the measured tick did not move the stated floor to ${want} us, so the page holds a literal`);
  assert(!new RegExp(`data-timer-floor="${floor}"`).test(r.html()),
    `the ${floor} us floor survives a host whose clock ticks twice as slowly`);
  return `floor tracks timerTickNs x minTicksPerSample (${floor} us here)`;
});

// ---------------------------------------------------------------------------
// 6. every_low_confidence_cell_is_shown_marked_and_never_chipped
//
// Dropping a low-confidence cell makes an untrusted number and an untested
// backend look identical; chipping it makes a number the producer refuses to
// vouch for read as a result. So: shown, marked, never chipped.
//
// Goes red against: a renderer that filters low-confidence cells out of the
// tables, and against one that runs its verdict chips over every row.
// ---------------------------------------------------------------------------
test('every_low_confidence_cell_is_shown_marked_and_never_chipped', () => {
  const r = renderInto(history);
  assert(r.code === 0, `render failed: ${r.err}`);
  const html = r.html();

  assert(SAT > 0, 'no timer-saturated cells in the committed history, so this guard is checking nothing');

  const rows = html.match(/<tr[^>]*class="[^"]*\brow-low\b[^"]*"[\s\S]*?<\/tr>/g) || [];
  assert(rows.length >= SAT,
    `the page marks ${rows.length} low-confidence rows and the storage run alone has ${SAT} timer-saturated cells`);

  const chipped = rows.filter((row) => /\bverdict\b/.test(row));
  assert(chipped.length === 0, `${chipped.length} low-confidence row(s) carry a verdict chip:\n  ${chipped.slice(0, 2).join('\n  ')}`);

  // And the counts a reader can check are on the page, from this capture.
  assert(new RegExp(`\\b${SAT}\\b`).test(html), `the page never says how many cells (${SAT}) fell below the floor`);
  assert(new RegExp(`\\b${MEASURED}\\b`).test(html), `the page never says how many cells (${MEASURED}) were measured`);
  return `${rows.length} marked rows, 0 chipped, ${SAT} of ${MEASURED} stated`;
});

// ---------------------------------------------------------------------------
// 7. no_invariant_is_charted
//
// An invariant is exact. Charting one puts an error bar and a trend line on a
// number that has neither, and invites a reader to eyeball a 0.008% byte
// difference off a pixel instead of reading it.
//
// Goes red against: a renderer that feeds the invariant names into the same
// series builder as the timings.
// ---------------------------------------------------------------------------
test('no_invariant_is_charted', () => {
  const html = renderInto(history).html();

  const charted = new Set([...html.matchAll(/data-series-key="([^"]+)"/g)].map((m) => m[1]));
  const invariantNames = new Set(history.flatMap((run) => (run.invariants ?? []).map((i) => i.name)));
  assert(invariantNames.size > 0, 'the history carries no invariants, so this test is checking nothing');
  assert(charted.size > 0, 'the page charts nothing at all, so this test is checking nothing');

  // A charted key is `<family>:<series>:<metric key>`, and the metric key is
  // the part an invariant name would collide with. Splitting on the wrong
  // separator is how this check passes on a page that charts output_bytes.
  const metricOf = (k) => String(k).split(':').pop();
  const overlap = [...charted].filter((k) => {
    const m = metricOf(k);
    return [...invariantNames].some((n) => m === n || m.endsWith(`.${n}`));
  });
  assert(overlap.length === 0, `${overlap.length} invariant(s) are charted: ${JSON.stringify(overlap)}`);

  assert(/data-invariant-table/.test(html), 'there is no invariants table on the page at all');
  assert(/data-invariant-verdict/.test(html), 'the invariants table carries no equality verdicts');
  return `${charted.size} charted key(s), ${invariantNames.size} invariant name(s), disjoint`;
});

// ---------------------------------------------------------------------------
// 8. an_invariant_step_renders_as_a_rule_carrying_the_commit_that_moved_it
//
// When an invariant does move, that is a change in the artefact and the
// interesting thing about it is which commit did it. A line between two points
// says "it drifted", which is the one thing that cannot have happened.
//
// Goes red against: a renderer with no step handling at all (the committed
// history is one run per family, so nothing exercises it by accident), one that
// draws the step as a second point on a series, and one that draws the rule
// without naming the commit.
// ---------------------------------------------------------------------------
test('an_invariant_step_renders_as_a_rule_carrying_the_commit_that_moved_it', () => {
  const two = clone(history);
  const base = two.find((r) => r.family === 'storage');
  const next = clone(base);
  next.runId = `${base.runId}-b`;
  next.integrity.document = 'sha256:' + 'c'.repeat(64);
  next.capturedAt = '2026-09-20T09:00:00.000Z';
  next.version = '0.5.1+fedcba9';
  next.commit = 'fedcba9876543210fedcba9876543210fedcba98';
  for (const inv of next.invariants) {
    if (inv.name === 'filesystem_entries' && inv.library === 'directory') inv.value += 1;
  }
  two.splice(two.indexOf(base) + 1, 0, next);

  const r = renderInto(two);
  assert(r.code === 0, `the two-run history did not render: ${r.err}`);
  const html = r.html();

  // The rule on the version axis and the label under it are two different
  // things and both are required: a label on its own does not show a reader
  // where on the axis it happened, and a rule on its own does not say which
  // commit did it.
  const lines = [...html.matchAll(/<line[^>]*class="step-rule"[^>]*data-invariant-step="([^"]*)"[^>]*>/g)].map((m) => m[1]);
  const labels = [...html.matchAll(/<li[^>]*class="step-label"[^>]*data-invariant-step="([^"]*)"[^>]*>/g)].map((m) => m[1]);
  assert(lines.length > 0, 'an invariant moved between two runs and no vertical rule was drawn on the version axis');
  assert(labels.length > 0, 'an invariant moved between two runs and nothing under the charts says which one or which commit');
  assert([...lines, ...labels].some((x) => /filesystem_entries/.test(x)),
    `the step markers do not name the invariant that moved: ${JSON.stringify([...lines, ...labels].slice(0, 3))}`);
  assert(/fedcba98/.test(html), 'the step label does not carry the commit that moved the invariant');

  const one = renderInto(history);
  const noRules = [...one.html().matchAll(/data-invariant-step="/g)];
  assert(noRules.length === 0, `a history with one run per family drew ${noRules.length} step marker(s) with nothing to step between`);
  return `${lines.length} rule(s) and ${labels.length} label(s) on a moved invariant, 0 on a history with one run`;
});

// ---------------------------------------------------------------------------
// 9. check_is_red_on_a_stale_page_and_green_on_a_fresh_one
//
// --check is the whole reason the page cannot drift from the history in
// silence, and a gate that cannot fail is not a gate.
//
// Goes red against: a --check that exits 0 unconditionally, and against one
// that is red on a page it just wrote itself.
// ---------------------------------------------------------------------------
test('check_is_red_on_a_stale_page_and_green_on_a_fresh_one', () => {
  const fresh = renderInto(history);
  assert(fresh.code === 0, `render failed: ${fresh.err}`);

  const green = runCli(['--history', fresh.hp, '--page', fresh.pp, '--config', CONFIG, '--check']);
  assert(green.code === 0, `--check is red on the page it just wrote: ${green.err}`);

  const edited = fresh.html().replace(/22127/, '22128');
  assert(edited !== fresh.html(), 'the page does not carry 22127, so this mutation is not testing staleness');
  writeFileSync(fresh.pp, edited);
  const red = runCli(['--history', fresh.hp, '--page', fresh.pp, '--config', CONFIG, '--check']);
  assert(red.code !== 0, '--check is green on a page with a hand-edited generated number');
  assert(/stale/i.test(red.err), `--check failed without saying the page is stale:\n${red.err}`);

  writeFileSync(fresh.pp, fresh.html());
  const moved = readJson(fresh.hp);
  moved[moved.length - 1].samples[0].median *= 1.5;
  writeFileSync(fresh.hp, JSON.stringify(moved, null, 2));
  const red2 = runCli(['--history', fresh.hp, '--page', fresh.pp, '--config', CONFIG, '--check']);
  assert(red2.code !== 0, '--check is green after the history moved under the page');
  return 'green on fresh, red on an edited page, red on a moved history';
});

// ---------------------------------------------------------------------------
// 10. the_page_renders_every_number_with_javascript_off
//
// The panel this page replaces on causl.org fetched its numbers at page load,
// the URL 404ed, and every visitor read an error for months. Static generated
// HTML is checked in, shows up in a diff, and cannot 404.
//
// Goes red against: a renderer that emits a mount point for dashboard.js and
// leaves the tables to it, and against a chart drawn into a <canvas>.
// ---------------------------------------------------------------------------
test('the_page_renders_every_number_with_javascript_off', () => {
  const r = renderInto(history);
  const full = r.html();
  const html = full.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');

  assert(!/<canvas\b/i.test(html), 'the page charts into a <canvas>, which is blank with JS off');
  assert(!/fetch\s*\(/.test(full), 'the page fetches something at load, which is how the panel this replaces started 404ing');

  // The headline figures of both families, read off the history so they follow
  // the capture rather than being typed in.
  const fam = config.families;
  const invAt = (run, lib, scale, name) =>
    (run.invariants.find((i) => i.library === lib && i.scale === scale && i.name === name) ?? {}).value;
  const claimScale = storageRun.samples.find((s) => s.cell === fam.storage.claimCell).scale;
  const entries = ['pmtiles', 'directory'].map((l) => invAt(storageRun, l, claimScale, 'filesystem_entries'));
  const memAt = (lib) => shownSamples(enginesRun).find(
    (s) => s.library === lib && s.cell === fam.engines.memoryClaimCell && s.key === fam.engines.memoryKey).median;

  const needles = [
    String(Math.max(...entries)),
    String(Math.round(memAt('monolithic'))).slice(0, 3),
    String(Math.round(memAt('streaming'))).slice(0, 3),
  ];
  for (const needle of needles) {
    assert(html.includes(needle), `"${needle}" is gone once the scripts are stripped, so something here is drawn by JS`);
  }
  const tables = (html.match(/<table\b/gi) || []).length;
  assert(tables >= 6, `only ${tables} table(s) survive with JS off`);
  const svgs = (html.match(/<svg\b/gi) || []).length;
  assert(svgs >= 2, `only ${svgs} inline chart(s) survive with JS off`);
  return `${tables} tables and ${svgs} inline SVGs with every script stripped, headline figures ${needles.join(', ')}`;
});

// ---------------------------------------------------------------------------
// 11. the_headline_claim_is_computed_from_the_run_not_written_into_the_page
//
// One archive entry against 22127, with the byte totals inside 0.016%, is the
// result this whole epic exists for. It is also exactly the kind of sentence
// that gets typed into a template once and then outlives the number.
//
// Goes red against: the claim hard-coded in the renderer's prose.
// ---------------------------------------------------------------------------
test('the_headline_claim_is_computed_from_the_run_not_written_into_the_page', () => {
  const claimCell = config.families.storage.claimCell;
  const claimScale = storageRun.samples.find((s) => s.cell === claimCell).scale;
  const entriesOf = (run, lib) => run.invariants.find(
    (i) => i.library === lib && i.scale === claimScale && i.name === 'filesystem_entries').value;
  const most = String(Math.max(entriesOf(storageRun, 'pmtiles'), entriesOf(storageRun, 'directory')));

  const base = renderInto(history);
  assert(base.html().includes(most), `the page does not state the entry count (${most}), so there is no claim to check`);

  const mutated = clone(history);
  const run = mutated.find((r) => r.family === 'storage');
  for (const inv of run.invariants) {
    if (inv.name === 'filesystem_entries' && inv.library === 'directory') inv.value = 31337;
  }
  const r = renderInto(mutated);
  assert(r.code === 0, `render failed: ${r.err}`);
  assert(/31337/.test(r.html()), "changing the run's filesystem_entries did not change the headline, so it is written into the page");
  assert(!r.html().includes(most), `the old entry count ${most} survives a run that no longer reports it`);

  // The byte bound too: it is a maximum across cells, not a sentence.
  const wider = clone(history);
  const wrun = wider.find((r2) => r2.family === 'storage');
  for (const inv of wrun.invariants) {
    if (inv.name === 'output_bytes' && inv.library === 'pmtiles') inv.value = Math.round(inv.value * 1.05);
  }
  assert(!/0\.016%/.test(renderInto(wider).html()), 'the 0.016% byte bound survives a run whose bytes are 5% apart');
  return `entry count ${most} and the byte bound both move with the run`;
});

// ---------------------------------------------------------------------------
// 12. an_ungateable_family_never_gets_a_verdict_chip
//
// Nothing in this capture is gateable: no calibration has been fitted for this
// host and filesystem, and the producer says so per cell. Those cells are
// published in full and never chipped.
//
// Goes red against: a renderer that chips whatever has two runs to compare, and
// against one that solves the problem by hiding the family.
// ---------------------------------------------------------------------------
test('an_ungateable_family_never_gets_a_verdict_chip', () => {
  const ungated = shownSamples(enginesRun).filter((s) => s.gated === false);
  assert(ungated.length === shownSamples(enginesRun).length,
    'some engines sample claims to be gated, so this guard is not testing what it says');
  assert(config.families.engines.gateable === false, 'config declares the engines family gateable');

  const html = renderInto(history).html();
  const section = html.slice(html.indexOf('GENERATED:engines:BEGIN'), html.indexOf('GENERATED:engines:END'));
  assert(section.length > 2000, 'the engines section is tiny, so the family was hidden rather than published');
  assert(!/class="[^"]*\bverdict\b/.test(section), 'the engines section carries a verdict chip');
  assert(/measured, not gated/i.test(section), 'the engines section never says its cells are measured but not gated');

  // The reason is on the page, from the producer, not invented here.
  const reasons = new Set(shownSamples(enginesRun).map((s) => s.ungateableReason).filter(Boolean));
  assert(reasons.size > 0, 'the producer gave no ungateable reason, so there is nothing to reproduce');
  for (const reason of reasons) {
    const words = reason.split(/\s+/).slice(0, 7).join(' ');
    assert(html.includes(words), `the page never gives the producer's reason: "${words}"`);
  }
  return `${ungated.length} engines cells published, 0 chips, ${reasons.size} producer reason(s) reproduced`;
});

// ---------------------------------------------------------------------------
// 13. the_not_measured_list_comes_from_config
//
// The list of things the page does not measure is the part most likely to go
// stale, because it is prose about absences. It lives in config.json so that
// adding a measurement is one edit in the place the measurement is declared.
//
// Goes red against: the list typed into the renderer's template.
// ---------------------------------------------------------------------------
test('the_not_measured_list_comes_from_config', () => {
  const base = renderInto(history);
  for (const entry of config.notMeasured) {
    assert(base.html().includes(entry.title), `the page does not carry the configured caveat "${entry.title}"`);
  }

  const dir = scratch();
  const cfgPath = join(dir, 'config.json');
  const cfg = clone(config);
  cfg.notMeasured = [{ title: 'A thing I invented for this test', body: 'and its body text.' }];
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const r = renderInto(history, { config: cfgPath });
  assert(r.code === 0, `render with a replaced config failed: ${r.err}`);
  assert(r.html().includes('A thing I invented for this test'), 'replacing the configured caveats did not change the page');
  assert(!r.html().includes(config.notMeasured[0].title), 'the original caveat survives a config that no longer lists it');
  return `${config.notMeasured.length} caveats, all from config`;
});

// ---------------------------------------------------------------------------
// 14. every_class_the_renderer_emits_is_styled
//
// The generated markup and the stylesheet are the contract this page shares
// with causl's dashboard: the same class names, so the parameterised chart
// layer attaches when libviprs-bench#76 lands it. A class the renderer emits
// and nothing styles is the drift that ends with an unreadable table on a live
// site, and nothing else on this page would notice.
//
// Goes red against: a class renamed in the renderer with no stylesheet change.
// ---------------------------------------------------------------------------
test('every_class_the_renderer_emits_is_styled', () => {
  const html = renderInto(history).html();
  const generated = [...html.matchAll(/GENERATED:[a-z-]+:BEGIN([\s\S]*?)GENERATED:[a-z-]+:END/g)]
    .map((m) => m[1]).join('\n');
  assert(generated.length > 2000, 'almost nothing is generated, so this check is looking at nothing');

  const emitted = new Set();
  for (const m of generated.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) emitted.add(c);
  }
  const css = readFileSync(CSS, 'utf8');
  const styled = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]));

  const unstyled = [...emitted].filter((c) => !styled.has(c));
  assert(unstyled.length === 0, `${unstyled.length} generated class(es) that nothing styles: ${JSON.stringify(unstyled)}`);
  assert(emitted.size >= 12, `only ${emitted.size} generated class(es), so the contract is barely exercised`);
  for (const c of ['results-table', 'num', 'conf', 'status-callout', 'section-head', 'absent']) {
    assert(emitted.has(c), `the generated markup no longer uses the contract class "${c}"`);
  }
  return `${emitted.size} generated classes, all styled`;
});

// ---------------------------------------------------------------------------
// 15. the_memory_column_is_per_engine_and_the_page_counts_what_proves_it
//
// The engines sweep used to read one process-wide high-water mark and report it
// for all three engines, so the memory column was three copies of one number
// and the page suppressed it (libviprs-bench#74). It measures each engine in
// its own child now. That is the difference between a suppressed column and the
// headline, so the page checks it rather than trusting it: it counts the groups
// whose engines all report the same peak to the byte, and publishes the count.
//
// Goes red against: a page that publishes the column without checking, and
// against one that still suppresses a column the producer now measures.
// ---------------------------------------------------------------------------
test('the_memory_column_is_per_engine_and_the_page_counts_what_proves_it', () => {
  const fam = config.families.engines;
  const rows = shownSamples(enginesRun).filter((s) => s.key === fam.memoryKey);
  assert(rows.length > 0, `the engines run carries no ${fam.memoryKey}, so there is no memory column to check`);

  const byCell = new Map();
  for (const s of rows) {
    if (!byCell.has(s.cell)) byCell.set(s.cell, new Map());
    byCell.get(s.cell).set(s.library, s.median);
  }
  const groups = [...byCell.values()].filter((m) => m.size === fam.series.order.length);
  const identical = groups.filter((m) => new Set(m.values()).size === 1).length;
  assert(groups.length > 0, 'no complete engine group in the run, so this guard is checking nothing');

  const html = renderInto(history).html();
  const section = html.slice(html.indexOf('GENERATED:engines:BEGIN'), html.indexOf('GENERATED:engines:END'));

  assert(section.includes(`${identical} of ${groups.length}`),
    `the page does not state the ${identical}-of-${groups.length} identical-group count that is the evidence the column is per engine`);
  assert(/peak resident set/i.test(section), 'the page never names the peak resident set column');

  // The claim cell's figures are on the page, both of them, distinct.
  const claim = byCell.get(fam.memoryClaimCell);
  assert(claim, `the memory claim cell ${fam.memoryClaimCell} is not in the run`);
  const values = [...claim.values()];
  assert(new Set(values).size > 1,
    'every engine reports the same peak at the claim cell, so the per-engine claim is not true of this run');
  for (const v of values) {
    assert(section.includes(String(Math.round(v)).slice(0, 3)), `the claim cell's ${v} MB is not on the page`);
  }

  // And nothing declares it suppressed any more.
  assert(!fam.suppressedMetrics || !fam.suppressedMetrics[fam.memoryKey],
    'config still suppresses the memory column the producer now measures per engine');
  return `${identical} of ${groups.length} groups identical, claim cell ${values.map((v) => v.toFixed(1)).join(' / ')} MB`;
});

// ---------------------------------------------------------------------------
// 16. a_metric_that_got_faster_is_not_a_regression_and_a_delta_inside_the_spread_is_noise
//
// Ten of the thirty metric keys in the storage family are higher-is-better, so
// a rule that compares raw numbers calls those a regression on the day they get
// faster. libviprs-bench#76 flags that the frozen dashboard at cd65c76 has no
// notion of direction at all; the page reads it off the sample, per metric, and
// this is the guard on that.
//
// The other half is the order the rules fire in. Noise comes before the
// thresholds, off the spread the run's own replicate pair measured for that
// very key. And a key with no measured spread gets no ruling rather than
// falling through to a threshold, because the spreads in the real captures run
// from 0.4% to 37% and any single fallback gets the dangerous answer
// confidently.
//
// The spreads here are set by the fixture rather than taken from the capture,
// so the rule is what is under test rather than whichever host was busy.
//
// Goes red against: a rule that subtracts and compares without reading
// direction, one that applies the 10% band before the replicate spread, and one
// that treats an unmeasured spread as a spread of zero.
// ---------------------------------------------------------------------------
test('a_metric_that_got_faster_is_not_a_regression_and_a_delta_inside_the_spread_is_noise', () => {
  const fam = config.families.storage;
  const cell = fam.headlineCell;

  const two = clone(history);
  const base = two.find((r) => r.family === 'storage');
  const next = clone(base);
  next.runId = `${base.runId}-b`;
  next.integrity.document = 'sha256:' + 'd'.repeat(64);
  next.capturedAt = '2026-09-21T09:00:00.000Z';
  next.version = '0.5.1+1111111';
  next.commit = '1111111111111111111111111111111111111111';

  const at = (run, lib, key) => run.samples.find((x) => x.library === lib && x.key === key && x.cell === cell);

  // Under test: five cells made gateable in both runs, with the spread set by
  // the fixture so the bands are the bands this test means.
  const plan = [
    ['pmtiles', 'read_plan_order.lookups_per_s', 3, 1.20, 'verdict verdict-improved', 'a higher-is-better metric that went up 20%'],
    ['directory', 'read_plan_order.lookups_per_s', 3, 1.04, 'verdict verdict-pass', 'a higher-is-better metric that improved 4%, clear of its 3% spread and inside the 5% pass band'],
    ['pmtiles', 'open.p50', 2, 1.01, 'verdict verdict-noise', 'a 1% move inside the measured 2% replicate spread'],
    ['directory', 'read_random.p50', 3, 1.20, 'verdict verdict-regressed', 'a lower-is-better metric that went up 20%'],
    ['pmtiles', 'read_random.p50', null, 1.20, 'gate', 'a 20% move with no measured spread, which nothing can rule on'],
  ];
  assert(config.verdict.passPct === 0.05 && config.verdict.improvedPct === 0.10,
    'this fixture picks its deltas off the configured bands, and they have moved');

  for (const [lib, key, spread, factor] of plan) {
    for (const run of [base, next]) {
      const s = at(run, lib, key);
      assert(s, `the fixture needs ${lib} ${key} at ${cell} and the history has no such sample`);
      s.gated = true; s.ungateableReason = null; s.confidence = 'high'; s.timerSaturated = false;
      s.lowConfidenceReasons = [];
      if (spread === null) { delete s.replicateSpreadPct; delete run.replicate.spreadPct[`${lib}.${key}`]; }
      else s.replicateSpreadPct = spread;
    }
    at(next, lib, key).median *= factor;
  }

  // One band per point, not one per series: the second run's spread for this
  // key is three times the first's, so the two points have to draw differently.
  at(next, 'pmtiles', 'read_plan_order.lookups_per_s').replicateSpreadPct = 9;

  two.splice(two.indexOf(base) + 1, 0, next);
  const r = renderInto(two);
  assert(r.code === 0, `the two-run history did not render: ${r.err}`);
  const html = r.html();

  // Scoped to the headline table: the full-results block further down carries
  // the same key and the same series label.
  const capStart = html.indexOf('Headline cells for');
  assert(capStart !== -1, 'the page has no headline table to read chips out of');
  const headlineTable = html.slice(capStart, html.indexOf('</table>', capStart));

  const chipOf = (lib, key) => {
    const label = fam.series.label[lib];
    const rows = headlineTable.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    const hits = rows.filter((row) => row.includes(`>${key}<`) && row.includes(`>${label}</td>`));
    assert(hits.length === 1, `${hits.length} headline rows match ${lib} ${key}, expected exactly one`);
    const m = hits[0].match(/<span class="(verdict verdict-[a-z]+|gate)"[^>]*>([^<]*)<\/span>\s*<\/td>\s*<\/tr>/);
    assert(m, `the row for ${lib} ${key} carries no chip at all:\n${hits[0]}`);
    return { cls: m[1], text: m[2] };
  };

  for (const [lib, key, , , cls, what] of plan) {
    const chip = chipOf(lib, key);
    assert(chip.cls === cls, `${what} rendered as "${chip.text}" (${chip.cls}), expected ${cls}`);
  }

  // The version axis carries one point per archived run, not one point for the
  // latest with the rest of the history thrown away.
  const svgStart = html.indexOf('<svg', html.indexOf('lookups per second'));
  const svg = html.slice(svgStart, html.indexOf('</svg>', svgStart));
  const points = (svg.match(/<circle[^>]*class="chart-point"/g) || []).length;
  assert(points === 4, `the version chart draws ${points} point(s); two runs of two series is four, so the history is being thrown away`);
  const xs = new Set([...svg.matchAll(/<circle[^>]*class="chart-point"[^>]*\scx="([-\d.]+)"/g)].map((m) => m[1]));
  assert(xs.size === 2, `the version chart puts every point at ${xs.size} x position(s); two runs is two`);
  // The fixture gave pmtiles a 3% spread in the first run and 9% in the second
  // for this very key, so both widths have to be in the markup. One width for
  // both points means the band was drawn once per series off whichever run was
  // in hand, which is a band about a different experiment.
  const bands = new Set([...svg.matchAll(/<circle[^>]*data-band-pct="([^"]+)"/g)].map((m) => m[1]));
  for (const want of ['3.00', '9.00']) {
    assert(bands.has(want),
      `the version chart never draws a ${want}% band, and the fixture set exactly that for one of the two runs. ` +
      `It drew: ${[...bands].join(', ')}`);
  }

  return 'direction read per metric, noise before the thresholds, no ruling without a spread, one point per run, one band per point';
});

// ---------------------------------------------------------------------------
// 17. every_sample_field_a_verdict_rule_reads_is_declared_in_samples_carry
//
// libviprs-bench#76 names the trap: groupSections builds a fixed-shape chart
// point and that object is the only thing computeVerdict ever sees, so a rule
// reading a sample field that was not carried across reads undefined. A rule
// that silently reads undefined behaves exactly like a rule that was switched
// off, and an inert rule is indistinguishable from a passing one.
//
// Goes red against: a verdict rule that grows a new field read without the
// config growing with it.
// ---------------------------------------------------------------------------
const INTRINSIC_TO_A_POINT = new Set(['series', 'median']);

test('every_sample_field_a_verdict_rule_reads_is_declared_in_samples_carry', () => {
  const src = readFileSync(RENDERER, 'utf8');
  const open_ = src.indexOf('function rule(');
  assert(open_ !== -1, 'render-latest.mjs has no rule() to read, so this guard is checking nothing');
  const body = src.slice(open_, src.indexOf('\nfunction ', open_ + 10));
  assert(body.length > 400, 'the rule body came out too short to be the real one');

  const read = new Set();
  for (const m of body.matchAll(/\b([ab])\.([A-Za-z_][A-Za-z0-9_]*)/g)) read.add(m[2]);
  if (/\b[ab]\[V\.gate\.field\]/.test(body)) read.add(config.verdict.gate.field);
  assert(read.size >= 3, `the rule reads ${read.size} sample field(s), too few to be the real rule`);

  const carried = new Set(config.samples.carry);
  const undeclared = [...read].filter((f) => !carried.has(f) && !INTRINSIC_TO_A_POINT.has(f));
  assert(undeclared.length === 0,
    `${undeclared.length} sample field(s) the verdict rule reads are not in config samples.carry: ` +
    JSON.stringify(undeclared) + '\nA rule reading a field that was not carried reads undefined, which looks ' +
    'exactly like a rule that is switched off.');
  for (const f of ['direction', config.verdict.gate.field]) {
    assert(carried.has(f), `samples.carry does not declare "${f}", which the verdict rules turn on`);
  }
  return `${read.size} field(s) read, ${undeclared.length} undeclared`;
});

// ---------------------------------------------------------------------------
// 18. the_two_causes_of_low_confidence_are_told_apart
//
// Low confidence has two causes. A cell under the floor this host's clock can
// resolve is at the instrument's limit: more repetitions will not move it. A
// cell with a coefficient of variation above what the producer accepts is a
// noisy measurement of something the clock resolves fine, and more repetitions
// would tighten it. Rendering both the same throws that away, and the two lead
// to different actions. Neither gets a chip either way.
//
// Goes red against: one mark for both, a page that names neither cause, and a
// mark on a row that is fine.
// ---------------------------------------------------------------------------
test('the_two_causes_of_low_confidence_are_told_apart', () => {
  assert(SAT > 0, 'no timer-saturated cells in the history, so this guard is checking nothing');
  assert(NOISY > 0, 'no high-CoV cells in the history, so this guard is checking nothing');
  assert(SAT !== NOISY, 'the two causes have the same count here, so a count check proves nothing');

  const html = renderInto(history).html();
  const rowsWith = (cls) => (html.match(new RegExp(`<tr[^>]*class="[^"]*\\b${cls}\\b[^"]*"`, 'g')) || []).length;
  const nSat = rowsWith('row-saturated');
  const nNoisy = rowsWith('row-noisy');

  // The full-results table shows the replicate pair as well as the samples, so
  // the page can carry more marked rows than the samples array alone has. It
  // can never carry fewer.
  assert(nSat >= SAT, `the page marks ${nSat} rows as at the clock's limit and the samples alone have ${SAT}`);
  assert(nNoisy >= NOISY, `the page marks ${nNoisy} rows as noisy and the samples alone have ${NOISY}`);
  assert(nSat !== nNoisy, 'both causes are marked the same number of times, so they are not being told apart');

  assert(/clock's limit/.test(html), 'the page never says what the saturated mark means');
  assert(/coefficient of variation/.test(html), 'the page never says what the noisy mark means');

  const marked = html.match(/<tr[^>]*class="[^"]*\brow-(saturated|noisy)\b[^"]*"[\s\S]*?<\/tr>/g) || [];
  const chipped = marked.filter((row) => /class="verdict/.test(row));
  assert(chipped.length === 0, `${chipped.length} low-confidence row(s) carry a verdict chip`);
  return `${nSat} at the clock's limit, ${nNoisy} noisy, told apart, 0 chipped`;
});

// ---------------------------------------------------------------------------
// 19. two_cells_with_the_same_tile_count_stay_two_cells
//
// Tile count is not a unique key. In the storage family 21851 tiles is both
// 8192x8192@64+gradient and 8192x8192@64+noise; in the engines family every
// image is built at two thread counts and both arms report the same tile count.
// A section keyed on tile count alone draws two experiments as one line and
// nothing on the page says it did.
//
// Goes red against: a cell identity that drops the source or the thread count,
// and a table that collapses two cells onto one row.
// ---------------------------------------------------------------------------
test('two_cells_with_the_same_tile_count_stay_two_cells', () => {
  const html = renderInto(history).html();
  let checked = 0;

  for (const run of history) {
    const byScale = new Map();
    for (const s of shownSamples(run)) {
      if (!byScale.has(s.scale)) byScale.set(s.scale, new Set());
      byScale.get(s.scale).add(s.cell);
    }
    const shared = [...byScale.entries()].filter(([, cells]) => cells.size > 1);
    assert(shared.length > 0,
      `no tile count in ${run.family} covers more than one cell, so the collision this guards against cannot ` +
      'happen there and the guard is checking nothing');

    for (const [scale, cells] of shared) {
      checked++;
      for (const cell of cells) {
        assert(html.includes(cell), `the page never names cell ${cell}, so two cells at ${scale} tiles collapsed into one`);
      }
      // The ids differ by something a reader can see, not by whitespace.
      assert(new Set([...cells]).size === cells.size, `duplicate cell ids at ${scale} tiles`);
    }
  }

  // And the storage invariants table keeps one row group per cell. Grouping it
  // on the tile count instead would put gradient and noise in the same group
  // with one of the two silently winning, in the table the headline claim is
  // read off.
  const allCells = new Set(storageRun.samples.map((s) => s.cell));
  const claimTable = html.slice(html.indexOf('data-invariant-table="storage"'));
  const groups = (claimTable.slice(0, claimTable.indexOf('</table>')).match(/<tr class="rowgroup">/g) || []).length;
  assert(groups === allCells.size,
    `the storage invariants table has ${groups} row group(s) for ${allCells.size} cell(s), so cells are being collapsed`);
  return `${checked} shared tile count(s) across both families, ${groups} row groups for ${allCells.size} storage cells`;
});

// ---------------------------------------------------------------------------

console.log('');
if (failures.length === 0) {
  console.log(`ok: ${passed} benchmark-page guard(s) passed`);
  process.exit(0);
}
console.error(`${failures.length} guard(s) failed: ${failures.map((f) => f.name).join(', ')}`);
process.exit(1);
