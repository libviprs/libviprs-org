#!/usr/bin/env node
/* benchmarks/tools/render-latest.test.mjs
 *
 * The guards for libviprs-org#76: /benchmarks/ becomes the generated libviprs
 * benchmark page, rendered from history.json, covering every family.
 *
 * Every test below names the wrong implementation it goes red against, because
 * a guard whose failure mode nobody wrote down tends not to have one.
 *
 *    1. a_run_that_is_not_archived_by_digest_is_refused
 *    2. the_low_confidence_band_is_computed_from_the_documents_own_timer
 *    3. every_low_confidence_cell_is_shown_marked_and_never_chipped
 *    4. no_invariant_is_charted
 *    5. an_invariant_step_renders_as_a_rule_carrying_the_commit_that_moved_it
 *    6. check_is_red_on_a_stale_page_and_green_on_a_fresh_one
 *    7. the_page_renders_every_number_with_javascript_off
 *    8. the_headline_claim_is_computed_from_the_run_not_written_into_the_page
 *    9. an_ungateable_family_never_gets_a_verdict_chip
 *   10. the_not_measured_list_comes_from_config
 *   11. every_class_the_renderer_emits_is_styled
 *   12. a_suppressed_metric_is_named_with_the_reason_it_is_suppressed
 *   13. a_metric_that_got_faster_is_not_a_regression_and_a_delta_inside_the_spread_is_noise
 *   14. every_sample_field_a_verdict_rule_reads_is_declared_in_samples_carry
 *   15. the_two_causes_of_low_confidence_are_told_apart
 *   16. two_cells_with_the_same_tile_count_stay_two_cells
 *
 * Plain Node, no dependency and no build step (libviprs-org#62).
 *
 * Usage:
 *   node benchmarks/tools/render-latest.test.mjs      # exit 1 on any failure
 */

import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs';
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

const mod = await import(`file://${RENDERER}`);

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

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const scratch = () => mkdtempSync(join(tmpdir(), 'libviprs-page-'));

/** Run the CLI with an isolated history/page pair, never the committed one. */
function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [RENDERER, ...args], { encoding: 'utf8', ...opts });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Render a history into a fresh page and hand back the HTML. */
function renderInto(history, { page = null } = {}) {
  const dir = scratch();
  const hp = join(dir, 'history.json');
  const pp = join(dir, 'index.html');
  writeFileSync(hp, JSON.stringify(history, null, 2));
  writeFileSync(pp, page ?? readFileSync(PAGE, 'utf8'));
  const r = runCli(['--history', hp, '--page', pp, '--config', CONFIG]);
  return { ...r, html: () => readFileSync(pp, 'utf8'), dir, hp, pp };
}

const history = readJson(HISTORY);
const config = readJson(CONFIG);
const storageRun = history.find((r) => r.family === 'storage');
const enginesRun = history.find((r) => r.family === 'engines');

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
  for (const drop of ['runId', 'documentDigest']) {
    const mutated = JSON.parse(JSON.stringify(history));
    delete mutated[mutated.length - 1][drop];
    const r = renderInto(mutated);
    assert(r.code !== 0, `a run with no ${drop} rendered anyway (exit ${r.code})`);
    assert(/refus/i.test(r.err), `a run with no ${drop} exited ${r.code} without saying it refused:\n${r.err}`);
    assert(new RegExp(drop).test(r.err), `the refusal for a missing ${drop} does not name it:\n${r.err}`);
  }

  // A digest that is not a digest is the same failure wearing a hat.
  const bad = JSON.parse(JSON.stringify(history));
  bad[bad.length - 1].documentDigest = 'trust me';
  const r = renderInto(bad);
  assert(r.code !== 0, 'a run whose documentDigest is not a digest rendered anyway');
  return 'missing runId, missing documentDigest and a malformed digest all refuse';
});

// ---------------------------------------------------------------------------
// 2. the_low_confidence_band_is_computed_from_the_documents_own_timer
//
// 4.1 microseconds is 41 ns of tick times a hundred-tick floor, and both of
// those are measured on the host and carried in the document. Writing 4.1 into
// the page makes it a fact about the machine that happened to run first.
//
// Goes red against: a renderer with the number in its template, which stays
// 4.1 when the host's tick changes.
// ---------------------------------------------------------------------------
test('the_low_confidence_band_is_computed_from_the_documents_own_timer', () => {
  const asIs = renderInto(history);
  assert(asIs.code === 0, `the committed history did not render: ${asIs.err}`);
  assert(/data-timer-floor="4\.1"/.test(asIs.html()), 'the rendered page never states the 4.1 us floor it computed');

  const doubled = JSON.parse(JSON.stringify(history));
  for (const run of doubled) if (run.measurement?.timerTickNs) run.measurement.timerTickNs *= 2;
  const r = renderInto(doubled);
  assert(r.code === 0, `the doubled-tick history did not render: ${r.err}`);
  assert(/data-timer-floor="8\.2"/.test(r.html()), 'doubling the measured timer tick did not move the stated floor to 8.2 us, so the page holds a literal');
  assert(!/data-timer-floor="4\.1"/.test(r.html()), 'the 4.1 us floor survives a host whose clock ticks twice as slowly');
  return 'floor tracks measurement.timerTickNs x measurement.minTicksPerSample';
});

// ---------------------------------------------------------------------------
// 3. every_low_confidence_cell_is_shown_marked_and_never_chipped
//
// 106 of the 332 measured cells in the first capture sit under the timer's
// trustworthy range. Dropping them makes an untrusted number and an untested
// backend look identical; chipping them makes a number the producer refuses to
// vouch for read as a result. So: shown, marked, never chipped.
//
// Goes red against: a renderer that filters low-confidence cells out of the
// tables, and against one that runs its verdict chips over every row.
// ---------------------------------------------------------------------------
test('every_low_confidence_cell_is_shown_marked_and_never_chipped', () => {
  const r = renderInto(history);
  assert(r.code === 0, `render failed: ${r.err}`);
  const html = r.html();

  const saturated = storageRun.samples.filter((s) => s.timerSaturated === true);
  assert(saturated.length === 106, `the committed history carries ${saturated.length} timer-saturated cells, expected 106`);

  const rows = html.match(/<tr[^>]*class="[^"]*\brow-low\b[^"]*"[\s\S]*?<\/tr>/g) || [];
  assert(
    rows.length >= saturated.length,
    `the page marks ${rows.length} low-confidence rows but the run has ${saturated.length} timer-saturated cells alone`);

  const chipped = rows.filter((row) => /\bverdict\b/.test(row));
  assert(chipped.length === 0, `${chipped.length} low-confidence row(s) carry a verdict chip:\n  ${chipped.slice(0, 2).join('\n  ')}`);

  assert(/106/.test(html), 'the page never says how many cells fell below the floor');
  assert(/332/.test(html), 'the page never says how many cells were measured in total');
  return `${rows.length} marked rows, 0 chipped, counts stated`;
});

// ---------------------------------------------------------------------------
// 4. no_invariant_is_charted
//
// An invariant is exact. Charting one puts an error bar and a trend line on a
// number that has neither, and invites a reader to eyeball a 0.008% byte
// difference off a pixel instead of reading it.
//
// Goes red against: a renderer that feeds the invariant names into the same
// series builder as the timings.
// ---------------------------------------------------------------------------
test('no_invariant_is_charted', () => {
  const r = renderInto(history);
  const html = r.html();

  const charted = new Set(
    [...html.matchAll(/data-series-key="([^"]+)"/g)].map((m) => m[1]));
  const invariantNames = new Set(
    history.flatMap((run) => (run.invariants ?? []).map((i) => i.name)));
  assert(invariantNames.size > 0, 'the history carries no invariants, so this test is checking nothing');
  assert(charted.size > 0, 'the page charts nothing at all, so this test is checking nothing');

  // A charted key is `<family>:<series>:<metric key>`, and the metric key is
  // the part an invariant name would collide with. Splitting on the wrong
  // separator is how this check passes on a page that charts output_bytes,
  // which is exactly the mutation it is here to catch.
  const metricOf = (k) => String(k).split(':').pop();
  const overlap = [...charted].filter((k) => {
    const m = metricOf(k);
    return [...invariantNames].some((n) => m === n || m.endsWith(`.${n}`));
  });
  assert(overlap.length === 0, `${overlap.length} invariant(s) are charted: ${JSON.stringify(overlap)}`);

  // And they are in a table, with a verdict, rather than merely absent.
  assert(/data-invariant-table/.test(html), 'there is no invariants table on the page at all');
  assert(/data-invariant-verdict/.test(html), 'the invariants table carries no equality verdicts');
  return `${charted.size} charted key(s), ${invariantNames.size} invariant name(s), disjoint`;
});

// ---------------------------------------------------------------------------
// 5. an_invariant_step_renders_as_a_rule_carrying_the_commit_that_moved_it
//
// When an invariant does move, that is a change in the artefact and the
// interesting thing about it is which commit did it. A line between two points
// says "it drifted", which is the one thing that cannot have happened.
//
// Goes red against: a renderer that has no step handling at all (the committed
// history is one run per family, so nothing exercises it by accident), and
// against one that draws the step as a second point on a series.
// ---------------------------------------------------------------------------
test('an_invariant_step_renders_as_a_rule_carrying_the_commit_that_moved_it', () => {
  const two = JSON.parse(JSON.stringify(history));
  const base = two.find((r) => r.family === 'storage');
  const next = JSON.parse(JSON.stringify(base));
  next.runId = base.runId.replace(/-0bc00939$/, '-deadbeef');
  next.documentDigest = 'sha256:' + 'c'.repeat(64);
  next.capturedAt = '2026-09-20T09:00:00.000Z';
  next.library = { ...base.library, commit: 'fedcba9876543210fedcba9876543210fedcba98', version: '0.5.1' };
  for (const inv of next.invariants) {
    if (inv.name === 'filesystem_entries' && inv.library === 'directory') inv.value = inv.value + 1;
  }
  two.splice(two.indexOf(base) + 1, 0, next);

  const r = renderInto(two);
  assert(r.code === 0, `the two-run history did not render: ${r.err}`);
  const html = r.html();

  // The rule on the version axis and the label under it are two different
  // things and both are required: a label on its own says an invariant moved
  // without showing a reader where on the axis, and a rule on its own does not
  // say which commit did it.
  const lines = [...html.matchAll(/<line[^>]*class="step-rule"[^>]*data-invariant-step="([^"]*)"[^>]*>/g)].map((m) => m[1]);
  const labels = [...html.matchAll(/<li[^>]*class="step-label"[^>]*data-invariant-step="([^"]*)"[^>]*>/g)].map((m) => m[1]);
  assert(lines.length > 0, 'an invariant moved between two runs and no vertical rule was drawn on the version axis for it');
  assert(labels.length > 0, 'an invariant moved between two runs and nothing under the charts says which one or which commit');
  const rules = [...lines, ...labels];
  assert(
    rules.some((r2) => /filesystem_entries/.test(r2)),
    `the step rules do not name the invariant that moved: ${JSON.stringify(rules)}`);
  assert(
    /fedcba98/.test(html),
    'the step rule does not carry the commit that moved the invariant');

  // And the one-run history draws none, rather than drawing one from nothing.
  const one = renderInto(history);
  const noRules = [...one.html().matchAll(/data-invariant-step="/g)];
  assert(noRules.length === 0, `the single-run history drew ${noRules.length} step rule(s) with nothing to step between`);
  return `${lines.length} rule(s) and ${labels.length} label(s) on a moved invariant, 0 on a history with one run`;
});

// ---------------------------------------------------------------------------
// 6. check_is_red_on_a_stale_page_and_green_on_a_fresh_one
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

  // Stale in the page: someone edited a generated number by hand.
  const edited = fresh.html().replace(/22127/, '22128');
  assert(edited !== fresh.html(), 'the page does not carry 22127, so this mutation is not testing staleness');
  writeFileSync(fresh.pp, edited);
  const red = runCli(['--history', fresh.hp, '--page', fresh.pp, '--config', CONFIG, '--check']);
  assert(red.code !== 0, '--check is green on a page with a hand-edited generated number');
  assert(/stale/i.test(red.err), `--check failed without saying the page is stale:\n${red.err}`);

  // Stale in the history: a new run landed and nobody re-rendered.
  writeFileSync(fresh.pp, fresh.html());
  const moved = JSON.parse(readFileSync(fresh.hp, 'utf8'));
  moved[moved.length - 1].samples[0].median *= 1.5;
  writeFileSync(fresh.hp, JSON.stringify(moved, null, 2));
  const red2 = runCli(['--history', fresh.hp, '--page', fresh.pp, '--config', CONFIG, '--check']);
  assert(red2.code !== 0, '--check is green after the history moved under the page');
  return 'green on fresh, red on an edited page, red on a moved history';
});

// ---------------------------------------------------------------------------
// 7. the_page_renders_every_number_with_javascript_off
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
  let html = r.html();
  html = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');

  assert(!/<canvas\b/i.test(html), 'the page charts into a <canvas>, which is blank with JS off');
  for (const needle of ['22127', '801', '49', '0.016', '4.1']) {
    assert(html.includes(needle), `"${needle}" is gone once the scripts are stripped, so something on this page is drawn by JS`);
  }
  const tables = (html.match(/<table\b/gi) || []).length;
  assert(tables >= 4, `only ${tables} table(s) survive with JS off`);
  const svgs = (html.match(/<svg\b/gi) || []).length;
  assert(svgs >= 2, `only ${svgs} inline chart(s) survive with JS off`);
  assert(!/fetch\s*\(/.test(r.html()), 'the page fetches something at load, which is how the panel this replaces started 404ing');
  return `${tables} tables and ${svgs} inline SVGs with every script stripped`;
});

// ---------------------------------------------------------------------------
// 8. the_headline_claim_is_computed_from_the_run_not_written_into_the_page
//
// One archive entry against 22127, with the byte totals inside 0.016%, is the
// result this whole epic exists for. It is also exactly the kind of sentence
// that gets typed into a template once and then outlives the number.
//
// Goes red against: the claim hard-coded in the renderer's prose.
// ---------------------------------------------------------------------------
test('the_headline_claim_is_computed_from_the_run_not_written_into_the_page', () => {
  const base = renderInto(history);
  assert(/22127/.test(base.html()), 'the page does not state the entry count, so there is no claim to check');

  const mutated = JSON.parse(JSON.stringify(history));
  const run = mutated.find((r) => r.family === 'storage');
  for (const inv of run.invariants) {
    if (inv.name === 'filesystem_entries' && inv.library === 'directory') inv.value = 31337;
  }
  const r = renderInto(mutated);
  assert(r.code === 0, `render failed: ${r.err}`);
  assert(/31337/.test(r.html()), 'changing the run\'s filesystem_entries did not change the headline, so it is written into the page');
  assert(!/22127/.test(r.html()), 'the old entry count survives a run that no longer reports it');

  // The byte bound too: it is a maximum across cells, not a sentence.
  const wider = JSON.parse(JSON.stringify(history));
  const wrun = wider.find((r) => r.family === 'storage');
  for (const inv of wrun.invariants) {
    if (inv.name === 'output_bytes' && inv.library === 'pmtiles') inv.value = Math.round(inv.value * 1.05);
  }
  const w = renderInto(wider);
  assert(!/0\.016%/.test(w.html()), 'the 0.016% byte bound survives a run whose bytes are 5% apart');
  return 'entry count and byte bound both move with the run';
});

// ---------------------------------------------------------------------------
// 9. an_ungateable_family_never_gets_a_verdict_chip
//
// The engines run is one measurement per cell with no repetitions, so it has
// no dispersion and there is nothing a pass or a regression could be read off.
// It is published in full and it is never chipped.
//
// Goes red against: a renderer that chips whatever has two runs to compare,
// and against one that solves the problem by hiding the family.
// ---------------------------------------------------------------------------
test('an_ungateable_family_never_gets_a_verdict_chip', () => {
  assert(enginesRun, 'the committed history carries no engines run');
  assert(config.families.engines.gateable === false, 'config declares the engines family gateable, so this test is checking nothing');
  assert(enginesRun.samples.every((s) => s.gated === false), 'some engines sample claims to be gated');

  const r = renderInto(history);
  const html = r.html();

  const section = html.slice(html.indexOf('GENERATED:engines:BEGIN'), html.indexOf('GENERATED:engines:END'));
  assert(section.length > 500, 'the engines section is empty, so the family was hidden rather than published');
  assert(!/class="[^"]*\bverdict\b/.test(section), 'the engines section carries a verdict chip');
  assert(/measured, not gated/i.test(section), 'the engines section never says its cells are measured but not gated');
  assert(/801/.test(section) && /49/.test(section), 'the engines section does not carry the tracked working set figures');
  return 'engines published in full, 0 chips, reason stated';
});

// ---------------------------------------------------------------------------
// 10. the_not_measured_list_comes_from_config
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
  const cfg = JSON.parse(JSON.stringify(config));
  cfg.notMeasured = [{ title: 'A thing I invented for this test', body: 'and its body text.' }];
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const hp = join(dir, 'history.json');
  const pp = join(dir, 'index.html');
  writeFileSync(hp, JSON.stringify(history, null, 2));
  writeFileSync(pp, readFileSync(PAGE, 'utf8'));
  const r = runCli(['--history', hp, '--page', pp, '--config', cfgPath]);
  assert(r.code === 0, `render with a replaced config failed: ${r.err}`);
  const html = readFileSync(pp, 'utf8');
  assert(html.includes('A thing I invented for this test'), 'replacing the configured caveats did not change the page');
  assert(!html.includes(config.notMeasured[0].title), 'the original caveat survives a config that no longer lists it');
  return `${config.notMeasured.length} caveats, all from config`;
});

// ---------------------------------------------------------------------------
// 11. every_class_the_renderer_emits_is_styled
//
// The generated markup and the stylesheet are the contract this page shares
// with causl's dashboard: the same class names, so the parameterised chart
// layer attaches when libviprs-bench#76 lands it. A class the renderer emits
// and nothing styles is the drift that ends with an unreadable table on a live
// site, and nothing else on this page would notice.
//
// Goes red against: a class renamed in the renderer with no stylesheet change,
// and against a stylesheet rule left behind for markup that no longer exists.
// ---------------------------------------------------------------------------
test('every_class_the_renderer_emits_is_styled', () => {
  const r = renderInto(history);
  const html = r.html();
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

  // The contract set specifically, so a rename shows up as this test rather
  // than as a silent restyle.
  for (const c of ['results-table', 'num', 'conf', 'status-callout', 'section-head', 'absent']) {
    assert(emitted.has(c), `the generated markup no longer uses the contract class "${c}"`);
  }
  return `${emitted.size} generated classes, all styled`;
});

// ---------------------------------------------------------------------------
// 12. a_suppressed_metric_is_named_with_the_reason_it_is_suppressed
//
// The engines sweep reports one peak RSS for all three engines because it reads
// a process-wide high-water mark. Publishing it would be three copies of the
// same number wearing three different labels. Dropping it silently would leave
// a reader wondering where the memory column went.
//
// Goes red against: a renderer that publishes the column, and against one that
// drops it with nothing said.
// ---------------------------------------------------------------------------
test('a_suppressed_metric_is_named_with_the_reason_it_is_suppressed', () => {
  const suppressed = config.families.engines.suppressedMetrics;
  assert(suppressed && Object.keys(suppressed).length > 0, 'config suppresses nothing, so this test is checking nothing');

  const r = renderInto(history);
  const html = r.html();
  const section = html.slice(html.indexOf('GENERATED:engines:BEGIN'), html.indexOf('GENERATED:engines:END'));

  for (const [key, reason] of Object.entries(suppressed)) {
    assert(section.includes(key), `the engines section never names the suppressed metric "${key}"`);
    const words = reason.split(/\s+/).slice(0, 8).join(' ');
    assert(section.includes(words), `the engines section names "${key}" without the reason it is suppressed`);
  }
  // 1808.6 is the shared watermark; it must not appear as a per-engine figure.
  assert(!/1808\.6/.test(section), 'the shared process-wide RSS watermark is published as a per-engine number');
  return `${Object.keys(suppressed).length} suppressed metric(s), each named with its reason`;
});

// ---------------------------------------------------------------------------
// 13. a_metric_that_got_faster_is_not_a_regression_and_a_delta_inside_the_spread_is_noise
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
// falling through to a threshold, because the capture's spreads run from 0.4%
// to 53.3% and any single fallback gets the dangerous answer confidently.
//
// Goes red against: a rule that subtracts and compares without reading
// direction, one that applies the 10% band before the replicate spread, and one
// that treats an unmeasured spread as a spread of zero.
// ---------------------------------------------------------------------------
test('a_metric_that_got_faster_is_not_a_regression_and_a_delta_inside_the_spread_is_noise', () => {
  const fam = config.families.storage;
  const cell = fam.headlineCell;

  const two = JSON.parse(JSON.stringify(history));
  const base = two.find((r) => r.family === 'storage');
  const next = JSON.parse(JSON.stringify(base));
  next.runId = base.runId.replace(/-0bc00939$/, '-0bc0093a');
  next.documentDigest = 'sha256:' + 'd'.repeat(64);
  next.capturedAt = '2026-09-21T09:00:00.000Z';
  next.library = { ...base.library, version: '0.5.1', commit: '1111111111111111111111111111111111111111' };

  const at = (run, series, key) => (run.samples ?? []).find(
    (x) => x.series === series && x.key === key && x.cell === cell && (x.replicateIndex ?? 0) === 0);

  // Make the five cells under test gateable in both runs, so the rule is what
  // decides the chip rather than the gate. gated implies high confidence
  // everywhere the importer writes it, so the fixture keeps that true.
  const gateable = [
    ['pmtiles', 'read_plan_order.lookups_per_s'],
    ['directory', 'read_plan_order.lookups_per_s'],
    ['pmtiles', 'open.p50'],
    ['pmtiles', 'read_random.p50'],
    ['directory', 'read_random.p50'],
  ];
  for (const run of [base, next]) {
    for (const [series, key] of gateable) {
      const s = at(run, series, key);
      assert(s, `the fixture needs ${series} ${key} at ${cell} and the history has no such sample`);
      s.gated = true; s.gateBlockers = []; s.confidence = 'high'; s.timerSaturated = false;
      s.lowConfidenceReasons = [];
    }
  }

  const spreadOf = (run, series, key) => run.replicate.spreadPct[`${series}.${key}`];
  const dirPlanSpread = spreadOf(next, 'directory', 'read_plan_order.lookups_per_s');
  assert(Number.isFinite(dirPlanSpread) && dirPlanSpread < 5,
    `the fixture needs directory read_plan_order.lookups_per_s to have a spread under 5%, it has ${dirPlanSpread}`);
  assert(config.verdict.passPct === 0.05 && config.verdict.improvedPct === 0.10,
    'this fixture picks its deltas off the configured bands, and they have moved');

  // higher-is-better, number UP 20%: improved. Never regressed.
  at(next, 'pmtiles', 'read_plan_order.lookups_per_s').median *= 1.20;
  // higher-is-better, number UP 5%: clear of its ~3.9% spread, inside the 10%
  // improved band and inside the 5% pass band, so it reads as a pass. This is
  // the literal shape of the direction trap: the number went up and a rule that
  // subtracts and compares calls it a regression.
  at(next, 'directory', 'read_plan_order.lookups_per_s').median *= 1.05;
  // lower-is-better, moved 1%, inside the ~2% spread: noise.
  at(next, 'pmtiles', 'open.p50').median *= 1.01;
  // lower-is-better, UP 20%: regressed.
  at(next, 'directory', 'read_random.p50').median *= 1.20;
  // lower-is-better, moved 20%, but nothing measured a spread for it: no ruling.
  at(next, 'pmtiles', 'read_random.p50').median *= 1.20;
  delete next.replicate.spreadPct['pmtiles.read_random.p50'];

  // One band per point, not one per series: the second run's spread for this
  // key is three times the first's, so the two points have to draw differently.
  next.replicate.spreadPct['pmtiles.read_plan_order.lookups_per_s'] =
    spreadOf(base, 'pmtiles', 'read_plan_order.lookups_per_s') * 3;

  two.splice(two.indexOf(base) + 1, 0, next);
  const r = renderInto(two);
  assert(r.code === 0, `the two-run history did not render: ${r.err}`);
  const html = r.html();

  // Scoped to the headline table, not the whole page: the full-results block
  // further down carries the same key and the same series label, and a search
  // over every <tr> would be reading whichever happened to come first.
  const capStart = html.indexOf('Headline cells for');
  assert(capStart !== -1, 'the page has no headline table to read chips out of');
  const headlineTable = html.slice(capStart, html.indexOf('</table>', capStart));

  const chipOf = (series, key) => {
    const label = fam.series.label[series];
    const rows = headlineTable.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    const hits = rows.filter((row) => row.includes(`>${key}<`) && row.includes(`>${label}</td>`));
    assert(hits.length === 1, `${hits.length} headline rows match ${series} ${key}, expected exactly one`);
    const m = hits[0].match(/<span class="(verdict verdict-[a-z]+|gate)"[^>]*>([^<]*)<\/span>\s*<\/td>\s*<\/tr>/);
    assert(m, `the row for ${series} ${key} carries no chip at all:\n${hits[0]}`);
    return { cls: m[1], text: m[2] };
  };

  const expect = [
    ['pmtiles', 'read_plan_order.lookups_per_s', 'verdict verdict-improved', 'a higher-is-better metric that went up 20%'],
    ['directory', 'read_plan_order.lookups_per_s', 'verdict verdict-pass', 'a higher-is-better metric that improved 5%, which is inside the pass band'],
    ['pmtiles', 'open.p50', 'verdict verdict-noise', 'a 1% move inside the measured replicate spread'],
    ['directory', 'read_random.p50', 'verdict verdict-regressed', 'a lower-is-better metric that went up 20%'],
    ['pmtiles', 'read_random.p50', 'gate', 'a 20% move with no measured spread, which nothing can rule on'],
  ];
  for (const [series, key, cls, what] of expect) {
    const chip = chipOf(series, key);
    assert(chip.cls === cls, `${what} rendered as "${chip.text}" (${chip.cls}), expected ${cls}`);
    assert(!/regress/.test(chip.cls) || cls.includes('regressed'),
      `${what} was called a regression, which is the direction trap`);
  }

  // The version axis carries one point per archived run, not one point for the
  // latest with the rest of the history thrown away.
  const svgStart = html.indexOf('<svg', html.indexOf('lookups per second'));
  const svg = html.slice(svgStart, html.indexOf('</svg>', svgStart));
  const points = (svg.match(/<circle[^>]*class="chart-point"/g) || []).length;
  assert(points === 4,
    `the version chart draws ${points} point(s); two runs of two series is four, so the history is being thrown away`);
  const xs = new Set([...svg.matchAll(/<circle[^>]*class="chart-point"[^>]*\scx="([-\d.]+)"/g)].map((m) => m[1]));
  assert(xs.size === 2, `the version chart puts every point at ${xs.size} x position(s); two runs is two`);

  const bands = new Set([...svg.matchAll(/<circle[^>]*data-band-pct="([^"]+)"/g)].map((m) => m[1]));
  assert(bands.size >= 3,
    `the version chart draws ${bands.size} distinct band width(s) across two runs whose spreads differ by a ` +
    'factor of three and two series; a band reused across the axis is a band about a different experiment');

  return 'direction read per metric, noise before the thresholds, no ruling without a spread, one point per run, one band per point';
});

// ---------------------------------------------------------------------------
// 14. every_sample_field_a_verdict_rule_reads_is_declared_in_samples_carry
//
// libviprs-bench#76 names the trap: groupSections builds a fixed-shape chart
// point and that object is the only thing computeVerdict ever sees, so a rule
// reading a sample field that was not carried across reads undefined. A rule
// that silently reads undefined behaves exactly like a rule that was switched
// off, and an inert rule is indistinguishable from a passing one.
//
// This renderer reads its samples directly rather than through groupSections,
// so it does not hit the trap today. It will the moment the frozen dashboard
// drives the same rules, and by then the rule and the config will be far apart
// in a diff. So the guard is now: every field the rule function reads is either
// declared in samples.carry or is one of the two things a chart point is by
// construction.
//
// Goes red against: a verdict rule that grows a new field read without the
// config growing with it.
// ---------------------------------------------------------------------------

// A point IS its series and its value; those are not carried, they are what a
// point is. Everything else a rule reads has to be declared.
const INTRINSIC_TO_A_POINT = new Set(['series', 'median']);

test('every_sample_field_a_verdict_rule_reads_is_declared_in_samples_carry', () => {
  const src = readFileSync(RENDERER, 'utf8');
  const open_ = src.indexOf('function rule(');
  assert(open_ !== -1, 'render-latest.mjs has no rule() to read, so this guard is checking nothing');
  const body = src.slice(open_, src.indexOf('\nfunction ', open_ + 10));
  assert(body.length > 400, 'the rule body came out too short to be the real one');

  const read = new Set();
  for (const m of body.matchAll(/\b([ab])\.([A-Za-z_][A-Za-z0-9_]*)/g)) read.add(m[2]);
  // b[V.gate.field] is a config-named read, so the field it names counts too.
  if (/\b[ab]\[V\.gate\.field\]/.test(body)) read.add(config.verdict.gate.field);
  assert(read.size >= 3, `the rule reads ${read.size} sample field(s), which is too few to be the real rule`);

  const carried = new Set(config.samples.carry);
  const undeclared = [...read].filter((f) => !carried.has(f) && !INTRINSIC_TO_A_POINT.has(f));
  assert(undeclared.length === 0,
    `${undeclared.length} sample field(s) the verdict rule reads are not in config samples.carry: ` +
    JSON.stringify(undeclared) + '\nA rule reading a field that was not carried reads undefined, which looks ' +
    'exactly like a rule that is switched off.');

  // And the two the direction and gate rules turn on specifically.
  for (const f of ['direction', config.verdict.gate.field]) {
    assert(carried.has(f), `samples.carry does not declare "${f}", which the verdict rules turn on`);
  }
  return `${read.size} field(s) read, ${undeclared.length} undeclared`;
});

// ---------------------------------------------------------------------------
// 15. the_two_causes_of_low_confidence_are_told_apart
//
// 159 cells in the first capture are low confidence and they are low for two
// different reasons. 106 sit under the floor this host's clock can resolve:
// that is the instrument's limit, and more repetitions will not move it. The
// rest have a coefficient of variation above what the producer accepts: the
// clock can resolve those perfectly well, the measurement simply moved about,
// and more repetitions would tighten them.
//
// Rendering both with the same mark throws that away, and the two lead to
// different actions. Neither gets a chip either way.
//
// Goes red against: one mark for both, a page that names neither cause, and a
// mark on a row that is fine.
// ---------------------------------------------------------------------------
test('the_two_causes_of_low_confidence_are_told_apart', () => {
  const r = renderInto(history);
  const html = r.html();

  const covFloor = storageRun.measurement.covLowConfidence;
  const saturated = storageRun.samples.filter((s) => s.timerSaturated === true);
  const noisy = storageRun.samples.filter((s) => Number.isFinite(s.cov) && s.cov > covFloor);
  assert(saturated.length === 106, `expected 106 timer-saturated cells, the history has ${saturated.length}`);
  assert(noisy.length > 0, 'no high-CoV cells in the history, so this guard is checking nothing');
  assert(saturated.length !== noisy.length, 'the two causes have the same count here, so a count check proves nothing');

  const rowsWith = (cls) => (html.match(new RegExp(`<tr[^>]*class="[^"]*\\b${cls}\\b[^"]*"`, 'g')) || []).length;
  const nSat = rowsWith('row-saturated');
  const nNoisy = rowsWith('row-noisy');
  assert(nSat === saturated.length, `the page marks ${nSat} rows as at the clock's limit, the run has ${saturated.length}`);
  assert(nNoisy === noisy.length, `the page marks ${nNoisy} rows as noisy, the run has ${noisy.length}`);
  assert(nSat !== nNoisy, 'both causes are marked the same number of times, so they are not being told apart');

  // Both causes are named on the page, with the number behind each.
  assert(/clock's limit/.test(html), 'the page never says what the saturated mark means');
  assert(/coefficient of variation/.test(html), 'the page never says what the noisy mark means');

  // And neither is chipped.
  const marked = html.match(/<tr[^>]*class="[^"]*\brow-(saturated|noisy)\b[^"]*"[\s\S]*?<\/tr>/g) || [];
  const chipped = marked.filter((row) => /class="verdict/.test(row));
  assert(chipped.length === 0, `${chipped.length} low-confidence row(s) carry a verdict chip`);
  return `${nSat} at the clock's limit, ${nNoisy} noisy, told apart, 0 chipped`;
});

// ---------------------------------------------------------------------------
// 16. two_cells_with_the_same_tile_count_stay_two_cells
//
// Tile count is not a unique key. 21851 tiles is both 8192x8192@64+gradient and
// 8192x8192@64+noise, and 16369 is both 4096x6256@46 cells. A section keyed on
// tile count alone draws gradient and noise as one line, and nothing on the
// page says it did.
//
// Goes red against: a cell identity that drops the source, and a table that
// collapses two cells onto one row.
// ---------------------------------------------------------------------------
test('two_cells_with_the_same_tile_count_stay_two_cells', () => {
  const byScale = new Map();
  for (const s of storageRun.samples) {
    if (!byScale.has(s.scale)) byScale.set(s.scale, new Set());
    byScale.get(s.scale).add(s.cell);
  }
  const shared = [...byScale.entries()].filter(([, cells]) => cells.size > 1);
  assert(shared.length > 0,
    'no tile count in this run covers more than one cell, so the collision this guards against cannot happen ' +
    'and the guard is checking nothing');

  for (const [scale, cells] of shared) {
    for (const cell of cells) {
      const own = storageRun.samples.filter((s) => s.cell === cell);
      const sources = new Set(own.map((s) => s.source));
      assert(sources.size === 1, `cell ${cell} carries ${sources.size} sources, so its identity is not a cell`);
      assert(cell.includes([...sources][0]),
        `cell id "${cell}" does not carry its source "${[...sources][0]}", so it collides with the other ` +
        `cell at ${scale} tiles`);
    }
  }

  const r = renderInto(history);
  const html = r.html();
  for (const [, cells] of shared) {
    for (const cell of cells) {
      assert(html.includes(cell), `the page never names cell ${cell}, so two cells collapsed into one`);
    }
  }

  // And the invariants table keeps one row group per cell. Grouping it on the
  // tile count instead would put gradient and noise in the same group with one
  // of the two silently winning, which is the collision in its most damaging
  // place: the table the headline claim is read off.
  const allCells = new Set(storageRun.samples.map((s) => s.cell));
  const groups = (html.match(/<tr class="rowgroup"><th scope="rowgroup"[^>]*>[\s\S]*?<\/tr>/g) || []).length;
  assert(groups === allCells.size,
    `the invariants table has ${groups} row group(s) for ${allCells.size} cell(s), so cells are being collapsed`);

  return `${shared.length} tile count(s) shared by more than one cell, ${groups} row groups for ${allCells.size} cells`;
});

// ---------------------------------------------------------------------------

console.log('');
if (failures.length === 0) {
  console.log(`ok: ${passed} benchmark-page guard(s) passed`);
  process.exit(0);
}
console.error(`${failures.length} guard(s) failed: ${failures.map((f) => f.name).join(', ')}`);
process.exit(1);
