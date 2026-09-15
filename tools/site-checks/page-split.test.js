#!/usr/bin/env node
/* libviprs-org/tools/site-checks/page-split.test.js
 *
 * The guards for libviprs-org#74: benchmarks/ becomes the libviprs page and
 * the libvips comparison article moves down into benchmarks/libvips/.
 *
 * Four tests, each one named for what it asserts and carrying the wrong
 * implementation it goes red against:
 *
 *   1. every_internal_link_resolves_to_a_file_that_exists
 *      (lives in ./links.js, which is also the standalone gate; called from
 *      here so one command runs the whole set)
 *   2. the_comparison_card_points_at_the_comparison_page
 *   3. the_moved_article_is_byte_identical_apart_from_its_relative_depth
 *   4. the_libviprs_page_publishes_no_number_that_is_not_generated
 *
 * Plus two the issue does not name but the move needs. The nav is the only way
 * a reader finds the second page at all, and .nojekyll is what stops Pages
 * running the whole site through Jekyll, which has swallowed a directory here
 * before:
 *
 *   5. every_nav_offers_both_benchmark_pages
 *   6. the_site_still_disables_jekyll_for_every_path_it_serves
 *
 * And two for what the move left behind it. The article described an encode
 * cost it does not exclude, and its own files went on naming the directories
 * they used to live in:
 *
 *   7. the_article_states_the_encoding_claim_it_measures
 *   8. the_comparison_pages_own_files_point_at_their_own_directory
 *
 * Plain Node, no dependency and no build step (libviprs-org#62).
 *
 * Usage:
 *   node tools/site-checks/page-split.test.js     # exit 1 on any failure
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const links = require('./links.js');
const ROOT = links.ROOT;

const ARTICLE = path.join(ROOT, 'benchmarks', 'libvips', 'index.html');
const PLACEHOLDER = path.join(ROOT, 'benchmarks', 'index.html');
const HOME = path.join(ROOT, 'index.html');

// The article exactly as it stood at benchmarks/index.html before the split,
// pinned by blob id. e7db3480f2d53f61832a5551c0bd952ee3337ba5 is the commit
// this branch forked from and `git rev-parse <it>:benchmarks/index.html` is
// where this id comes from. A blob reachable from main's history is in every
// full clone forever, which is what makes test 3 mean something after the
// merge as well as before it. A shallow clone does not have it, so the
// workflow that runs this checks out with fetch-depth: 0 and the test fails
// loudly rather than skipping when the object is missing: a skip is the same
// colour as a pass.
const PRE_SPLIT_ARTICLE_BLOB = 'aa612770696e0c344ea132e84a2ea2e2b2a1e339';

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

const failures = [];

function test(name, fn) {
  try {
    const note = fn();
    console.log('\x1b[32mPASS\x1b[0m  ' + name);
    if (note) console.log('        ' + note);
  } catch (e) {
    failures.push({ name, message: e.message });
    console.log('\x1b[31mFAIL\x1b[0m  ' + name);
    for (const line of String(e.message).split('\n')) console.log('        ' + line);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function read(file) {
  assert(fs.existsSync(file), 'expected this file to exist: ' + path.relative(ROOT, file));
  return fs.readFileSync(file, 'utf8');
}

// ---------------------------------------------------------------------------
// Nav parsing, shared by tests 3 and 5
// ---------------------------------------------------------------------------

function navOf(html, label) {
  const open = html.indexOf('<nav class="topbar-menu"');
  assert(open !== -1, label + ': no <nav class="topbar-menu"> in this page');
  const close = html.indexOf('</nav>', open);
  assert(close !== -1, label + ': the topbar nav is never closed');
  return html.slice(open, close + '</nav>'.length);
}

function navEntries(html, label) {
  const nav = navOf(html, label);
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(nav)) !== null) {
    const attrs = m[1];
    const href = (attrs.match(/href\s*=\s*"([^"]*)"/) || [])[1] || '';
    const cls = (attrs.match(/class\s*=\s*"([^"]*)"/) || [])[1] || '';
    const full = (m[2].match(/nav-label-full">([\s\S]*?)<\/span>/) || [])[1] || '';
    out.push({ href, cls, label: full.trim(), current: /\bis-current\b/.test(cls) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. every_internal_link_resolves_to_a_file_that_exists
//
// Goes red against: the move with the four inbound references left alone, and
// against a moved article whose `../` never gained its level. The whole
// implementation and its reasoning are in ./links.js.
// ---------------------------------------------------------------------------

test('every_internal_link_resolves_to_a_file_that_exists', () => {
  const findings = links.check();
  const pages = links.htmlFiles();
  assert(pages.length >= 5, 'only ' + pages.length + ' page(s) walked, so this check is looking at almost nothing');
  assert(
    findings.length === 0,
    findings.length + ' unresolved reference(s):\n' +
      findings.map((f) => '  ' + f.file + ':' + f.line + '  ' + f.attr + '="' + f.value + '"  ->  ' + f.resolved).join('\n'));
});

// ---------------------------------------------------------------------------
// 2. the_comparison_card_points_at_the_comparison_page
//
// The clipping card on the front page is not a nav item. Its whole body is the
// libvips pitch, so it has to land on the page that makes that claim.
//
// Goes red against: a card still pointing at benchmarks/, which after the
// split is the libviprs page and says nothing about the C heavyweight the card
// just promised.
// ---------------------------------------------------------------------------

test('the_comparison_card_points_at_the_comparison_page', () => {
  const html = read(HOME);
  const re = /<a\b([^>]*\bclass="[^"]*\bclipping\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/g;
  const cards = [];
  let m;
  while ((m = re.exec(html)) !== null) cards.push({ attrs: m[1], body: m[2] });

  assert(cards.length === 1, 'expected exactly one clipping card on the front page, found ' + cards.length);

  const card = cards[0];
  assert(
    /outperforming the C heavyweight/.test(card.body),
    'the clipping card no longer carries the libvips pitch, so this test is guarding the wrong element');
  assert(
    /libvips/.test(card.body),
    'the clipping card does not mention libvips, so this test is guarding the wrong element');

  const href = (card.attrs.match(/href\s*=\s*"([^"]*)"/) || [])[1];
  assert(
    href === 'benchmarks/libvips/',
    'the clipping card points at "' + href + '". Its body is the libvips comparison pitch, so it has ' +
      'to point at "benchmarks/libvips/" rather than at the libviprs page.');
});

// ---------------------------------------------------------------------------
// 3. the_moved_article_is_byte_identical_apart_from_its_relative_depth
//
// This is the one that stops a content edit riding along inside a move. It
// takes the pre-split article out of git, adds one `../` level to every
// relative href and src in it, applies the edits the split is allowed to carry
// (each declared below as the literal text it replaces and the literal text it
// puts there, so every one of them is reviewable in the diff of this file) and
// then demands the result equal the moved article byte for byte.
//
// Goes red against: any prose, number, table, chart or markup edit smuggled
// into the move, and against a depth fix that missed a reference or added a
// level to one that did not need it. Widening what the article may carry means
// writing the new prose into this file, where somebody reads it.
//
// It is a one-shot by design, anchored on a blob from before the split. What to
// do when you change the article, and when this guard has done its job and may
// be re-anchored, is written above DECLARED_EDITS below. Read that before
// deleting anything here.
// ---------------------------------------------------------------------------

// The nav entry as it stands after the pure move, before the split's own edit.
const NAV_BEFORE = [
  '      <a href="./" class="nav-item is-current">',
  '        <span class="nav-label nav-label-full">Benchmarks</span>',
  '        <span class="nav-label nav-label-short">Bench</span>',
  '      </a>',
].join('\n');

// And after it: Benchmarks now points one level up at the libviprs page, and
// the comparison gets its own entry, which is the page you are on.
const NAV_AFTER = [
  '      <a href="../" class="nav-item">',
  '        <span class="nav-label nav-label-full">Benchmarks</span>',
  '        <span class="nav-label nav-label-short">Bench</span>',
  '      </a>',
  '',
  '      <a href="./" class="nav-item is-current">',
  '        <span class="nav-label nav-label-full">libviprs vs libvips</span>',
  '        <span class="nav-label nav-label-short">vs libvips</span>',
  '      </a>',
].join('\n');

// The encoding story the article told, and the one the code has told since
// libviprs-bench#153 put both sides on the same codec. The article claimed the
// comparison excludes encode cost when it includes it, which changes how every
// number on the page reads, so it is fixed before the page goes live at its new
// URL rather than left to the generated-page issue.
//
// Checked against libviprs-bench rather than pasted: BENCH_TILE_FORMAT is
// TileFormat::Png (src/lib.rs:37), the three engines in the sweep each build
// FsSink::new(out_dir.join("pyramid")).with_format(TileFormat::Png) under a
// temp dir (src/scalability.rs:113-127, 167, 210), all three engines plan with
// Layout::DeepZoom, and every libvips path passes BENCH_TILE_SUFFIX (".png")
// to dzsave: the CLI ones as --suffix (src/lib.rs:1057, 1123, 1138) and the
// in-process FFI one as the "suffix" option (src/lib.rs:1353-1368), which is
// the path that used to write .raw and is exactly what #153 changed.
const ENCODING_BEFORE_METHOD =
  'libvips writes raw tiles to a tmpdir (the minimum <code>dzsave</code> allows); libviprs writes ' +
  'to a <code>MemorySink</code> (in-memory collection). Neither side encodes to PNG or JPEG ' +
  '&mdash; this is pure pyramid generation throughput.';

const ENCODING_AFTER_METHOD =
  'From there every engine writes its tiles as PNG files to a real on-disk sink under the same ' +
  'DeepZoom layout, so neither side gets an in-RAM-sink or tile-codec advantage: <code>dzsave</code> ' +
  'is invoked with <code>--suffix .png</code>, and the libviprs engines write through an ' +
  '<code>FsSink</code> at the same codec.';

// The sentence that justified the in-RAM sink. With the sink gone it argued
// against the methodology the rest of the paragraph describes, so the paragraph
// talked itself out of its own design. The point it was making is still true and
// still worth making, it just belongs the other way round now: an asymmetric
// sink measures storage rather than tiling, which is the reason both sides write
// PNG to disk rather than the reason neither does.
const SSD_BEFORE_METHOD = "Write to disk and you're measuring your SSD.";

const SSD_AFTER_METHOD =
  "Let one side write to disk while the other holds tiles in RAM and you're measuring your SSD.";

const ENCODING_BEFORE_NOTES =
  'and <code>vips_dzsave</code> writes raw tiles (no encoding) to a temporary directory, while ' +
  'libviprs engines write to a <code>MemorySink</code>.';

const ENCODING_AFTER_NOTES =
  'and <code>vips_dzsave</code> writes PNG tiles to a temporary directory, and the libviprs ' +
  'engines write PNG tiles to one of their own through <code>FsSink</code>, so the encode cost is ' +
  'paid on both sides.';

// Every edit the moved article is allowed to carry on top of its new depth.
// Each one has to match the pre-split article exactly once, and anything the
// list does not describe fails the guard.
//
// WHEN YOU CHANGE THE ARTICLE ON PURPOSE: add an entry here with the exact text
// you replaced, the exact text you put there, and a `why` a stranger can read.
// That is the whole contract. Do not delete this guard, widen deepen(), or
// relax the comparison to get green: every one of those turns a proof into a
// decoration, and the reason this exists is that a content edit inside a move
// is invisible in a rename diff.
//
// WHEN IT MAY GO: this guard proves one thing, that the split carried the
// article across untouched, and it proves it against a blob from before the
// split. It has done that job when the article stops being the moved artefact
// and becomes a maintained one, which in practice is the first time the page is
// regenerated or rewritten wholesale rather than edited sentence by sentence.
// The expected occasion is the provenance callout, which needs an archived run
// to point at and lands with K2.5. At that point the honest move is to
// RE-ANCHOR rather than delete: re-pin PRE_SPLIT_ARTICLE_BLOB to the article as
// it then stands, empty this list, and say so in the commit. A deletion commit
// that only says "no longer needed" is the failure mode, not the retirement.
//
// The soft note below says when the list has grown past the point where anyone
// reads it, which is the other signal that re-anchoring is overdue.
const DECLARED_EDITS_SOFT_LIMIT = 8;
const DECLARED_EDITS = [
  {
    why: 'the nav gains the comparison entry, and Benchmarks points up at the libviprs page',
    before: NAV_BEFORE,
    after: NAV_AFTER,
  },
  {
    why: 'How We Tested said neither side encodes, and both sides have encoded PNG since libviprs-bench#153',
    before: ENCODING_BEFORE_METHOD,
    after: ENCODING_AFTER_METHOD,
  },
  {
    why: 'the same paragraph opened by arguing against the methodology it goes on to describe',
    before: SSD_BEFORE_METHOD,
    after: SSD_AFTER_METHOD,
  },
  {
    why: 'the methodology notes told the same stale story a second time',
    before: ENCODING_BEFORE_NOTES,
    after: ENCODING_AFTER_NOTES,
  },
];

function deepen(text) {
  return text.replace(/((?:href|src)=")(\.\.\/)/g, '$1../$2');
}

test('the_moved_article_is_byte_identical_apart_from_its_relative_depth', () => {
  let original;
  try {
    original = execFileSync('git', ['cat-file', 'blob', PRE_SPLIT_ARTICLE_BLOB], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(
      'could not read the pre-split article from git (blob ' + PRE_SPLIT_ARTICLE_BLOB + ').\n' +
      'This test compares the moved file against what it was, so it needs the full history: ' +
      'check out with fetch-depth: 0. It fails rather than skips on purpose.\n' +
      'git said: ' + String(e.message).trim());
  }

  assert(original.length > 10000, 'the pre-split article came back as ' + original.length + ' bytes, which is not it');

  const moved = read(ARTICLE);

  // The depth fix has to have done something, or this test passes on a file
  // that was never re-pointed.
  const deepened = deepen(original);
  const levels = (original.match(/(?:href|src)="\.\.\//g) || []).length;
  assert(levels > 0, 'the pre-split article has no relative `../` reference at all, so there is nothing to deepen');
  assert(deepened !== original, 'deepen() changed nothing, so this test is comparing the article against itself');
  assert(
    !/(?:href|src)="\.\.\/\.\.\//.test(original),
    'the pre-split article already contains a two-level `../../`, which this transform cannot reason about');

  let expected = deepened;
  for (const edit of DECLARED_EDITS) {
    assert(
      expected.split(edit.before).length === 2,
      'the declared edit "' + edit.why + '" does not match the pre-split article exactly once ' +
        '(' + (expected.split(edit.before).length - 1) + ' match(es)), so the declaration no longer ' +
        'describes the move. Fix the literal in this file rather than relaxing the comparison.');
    expected = expected.replace(edit.before, edit.after);
  }

  if (expected !== moved) {
    const a = expected.split('\n');
    const b = moved.split('\n');
    const diffs = [];
    for (let i = 0; i < Math.max(a.length, b.length) && diffs.length < 8; i++) {
      if (a[i] !== b[i]) {
        diffs.push(
          '  line ' + (i + 1) + '\n' +
          '    expected: ' + JSON.stringify(a[i] === undefined ? null : a[i]) + '\n' +
          '    actual:   ' + JSON.stringify(b[i] === undefined ? null : b[i]));
      }
    }
    throw new Error(
      'the moved article is not the pre-split article plus one `../` level and the ' +
      DECLARED_EDITS.length + ' declared edit(s).\n' +
      'Lines: expected ' + a.length + ', actual ' + b.length + '. First differences:\n' + diffs.join('\n') +
      '\nEverything else in that file moves untouched; the content belongs to a later issue.');
  }

  if (DECLARED_EDITS.length > DECLARED_EDITS_SOFT_LIMIT) {
    console.log('        note: ' + DECLARED_EDITS.length + ' declared edits, past the ' +
      DECLARED_EDITS_SOFT_LIMIT + ' this guard stays readable at. The article is being maintained ' +
      'rather than moved now, so re-anchor PRE_SPLIT_ARTICLE_BLOB and empty the list; see the ' +
      'retirement note above DECLARED_EDITS.');
  }

  return levels + ' relative reference(s) gained a level and ' + DECLARED_EDITS.length +
    ' declared edit(s) applied; the rest of the file is byte for byte';
});

// ---------------------------------------------------------------------------
// 4. the_libviprs_page_publishes_no_number_that_is_not_generated
//
// Nothing goes on the libviprs page that is not generated from an archived run
// addressed by digest. While there were no archived runs, that meant the page
// carried no number at all; libviprs-org#76 landed the first two runs, so the
// rule now has teeth in the other direction: every digit a reader can see is
// inside a GENERATED:<name>:BEGIN/END region, and the page names the run and
// the document digest each region came from.
//
// The hand-written frame around those regions keeps the old rule exactly. A
// figure typed into the standfirst is the failure this has always been about,
// and it still fails here.
//
// Goes red against: a hand-written figure in the prose outside the markers, a
// generated region that turns out to carry no numbers (a renderer that silently
// emitted nothing), a page that shows numbers without naming the run they came
// from, and a chart dropped in as an image or a <canvas> rather than as markup
// a reader sees with JavaScript off.
// ---------------------------------------------------------------------------

function visibleText(html) {
  let t = links.markupOnly(html);
  t = t.replace(/<[^>]*>/g, ' ');
  t = t.replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

// Blank a generated region while keeping its newlines, so line numbers in any
// later failure still point at the right place.
function withoutGenerated(html) {
  return html.replace(
    /<!--\s*GENERATED:[a-z-]+:BEGIN\s*-->[\s\S]*?<!--\s*GENERATED:[a-z-]+:END\s*-->/g,
    (m) => m.replace(/[^\n]/g, ' '));
}

test('the_libviprs_page_publishes_no_number_that_is_not_generated', () => {
  const html = read(PLACEHOLDER);

  const regions = html.match(/<!--\s*GENERATED:([a-z-]+):BEGIN\s*-->/g) || [];
  assert(regions.length >= 1, 'the libviprs page has no GENERATED region at all, so nothing on it is generated');

  const generated = html.slice(0).match(
    /<!--\s*GENERATED:[a-z-]+:BEGIN\s*-->[\s\S]*?<!--\s*GENERATED:[a-z-]+:END\s*-->/g) || [];
  const generatedDigits = generated.join('\n').match(/\d/g) || [];
  assert(
    generatedDigits.length > 200,
    'the generated regions carry ' + generatedDigits.length + ' digit(s), so the renderer emitted almost nothing ' +
      'and the rest of this test would pass on an empty page');

  assert(!/<canvas\b/i.test(html), 'the libviprs page charts into a <canvas>, which is blank with JavaScript off');
  const images = (html.match(/<img\b[^>]*src="(?!https?:)[^"]*"/gi) || []);
  assert(images.length === 0,
    'the libviprs page carries a local image, which on this site means a chart, and a chart here is inline SVG so a ' +
      'reader sees it with JavaScript off:\n  ' + images.join('\n  '));

  // Every run the page renders has to be named on the page, by id and by
  // digest. "Generated from an archived run" is only checkable if the page says
  // which one.
  const historyPath = path.join(ROOT, 'benchmarks', 'history.json');
  assert(fs.existsSync(historyPath), 'benchmarks/history.json is missing, so the page has nothing to be generated from');
  const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  assert(Array.isArray(history) && history.length > 0, 'benchmarks/history.json holds no runs');
  for (const run of history) {
    // The importer carries the producer's own integrity block through, so the
    // document digest lives at integrity.document; the flat spelling is what a
    // history written before that block was carried has. Reading only one of
    // the two is the shape mismatch that cost this lane a round.
    const digest = (run.integrity && run.integrity.document) || run.documentDigest;
    assert(run.runId && digest,
      'a run in benchmarks/history.json has no runId, and no digest at integrity.document or documentDigest, ' +
        'so it is not archived by digest');
    assert(html.includes(run.runId), 'the page renders run ' + run.runId + ' without naming it');
    assert(html.includes(digest),
      'the page renders run ' + run.runId + ' without naming the document digest it came from');
  }

  // And the frame around the generated regions stays free of figures.
  const frame = visibleText(withoutGenerated(html));
  assert(frame.length > 80, 'the hand-written frame has almost no text on it (' + frame.length + ' chars), so this test is checking nothing');

  const digits = frame.match(/[^ ]*\d[^ ]*/g) || [];
  assert(
    digits.length === 0,
    'the hand-written frame of the libviprs page shows ' + digits.length + ' number(s) a reader can see: ' +
      JSON.stringify(digits) + '\n' +
      'Every number on that page comes out of an archived run through ' +
      'benchmarks/tools/render-latest.mjs, which means it lives between GENERATED markers.');

  return regions.length + ' generated region(s), ' + generatedDigits.length + ' generated digit(s), ' +
    history.length + ' run(s) named by id and digest, 0 figures in the frame';
});

// ---------------------------------------------------------------------------
// 5. every_nav_offers_both_benchmark_pages
//
// The split only works if a reader can get to the second page. Every nav on
// the site carries both entries, at the depth its own page needs, and the
// current-page marker sits on the page you are actually on.
//
// Goes red against: a nav that gained the comparison entry on some pages and
// not others, one that points at it from the wrong depth, and a moved article
// whose nav still marks the libviprs page as the current one.
// ---------------------------------------------------------------------------

test('every_nav_offers_both_benchmark_pages', () => {
  const expectations = [
    { file: 'index.html', libviprs: 'benchmarks/', libvips: 'benchmarks/libvips/', current: null },
    { file: 'roadmap.html', libviprs: 'benchmarks/', libvips: 'benchmarks/libvips/', current: null },
    { file: 'cli/index.html', libviprs: '../benchmarks/', libvips: '../benchmarks/libvips/', current: null },
    { file: 'benchmarks/index.html', libviprs: './', libvips: 'libvips/', current: 'libviprs' },
    { file: 'benchmarks/libvips/index.html', libviprs: '../', libvips: './', current: 'libvips' },
  ];

  const problems = [];
  for (const e of expectations) {
    const html = read(path.join(ROOT, e.file));
    const entries = navEntries(html, e.file);

    const libviprs = entries.filter((x) => x.label === 'Benchmarks');
    const libvips = entries.filter((x) => x.label === 'libviprs vs libvips');

    if (libviprs.length !== 1) problems.push(e.file + ': expected one "Benchmarks" nav entry, found ' + libviprs.length);
    else if (libviprs[0].href !== e.libviprs) problems.push(e.file + ': "Benchmarks" points at "' + libviprs[0].href + '", expected "' + e.libviprs + '"');

    if (libvips.length !== 1) problems.push(e.file + ': expected one "libviprs vs libvips" nav entry, found ' + libvips.length);
    else if (libvips[0].href !== e.libvips) problems.push(e.file + ': "libviprs vs libvips" points at "' + libvips[0].href + '", expected "' + e.libvips + '"');

    if (e.current && libviprs.length === 1 && libvips.length === 1) {
      const wanted = e.current === 'libviprs' ? libviprs[0] : libvips[0];
      const other = e.current === 'libviprs' ? libvips[0] : libviprs[0];
      if (!wanted.current) problems.push(e.file + ': its own nav entry is not marked is-current');
      if (other.current) problems.push(e.file + ': the other benchmark page is marked is-current on it');
    }
  }

  assert(problems.length === 0, problems.length + ' nav problem(s):\n  ' + problems.join('\n  '));
});

// ---------------------------------------------------------------------------
// 6. the_site_still_disables_jekyll_for_every_path_it_serves
//
// Pages runs a repo through Jekyll unless .nojekyll is at the root, and Jekyll
// drops anything whose path carries a leading underscore. That has taken out a
// whole API reference on another site of mine, silently, so the file is
// load-bearing rather than decorative. The move adds a directory, and this is
// the cheap check that the new paths are still covered.
//
// Goes red against: .nojekyll deleted or moved out of the root, and against a
// published path that would need Jekyll off to survive while relying on it
// being there by luck.
// ---------------------------------------------------------------------------

test('the_site_still_disables_jekyll_for_every_path_it_serves', () => {
  assert(
    fs.existsSync(path.join(ROOT, '.nojekyll')),
    '.nojekyll is gone from the repo root. Without it Pages runs this site through Jekyll, which drops ' +
      'every path with a leading underscore in it.');

  const underscored = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'target') continue;
      const rel = path.relative(ROOT, path.join(dir, entry.name));
      if (entry.name.startsWith('_')) underscored.push(rel);
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  })(ROOT);

  // Not a failure in itself, since .nojekyll above is what makes them safe.
  // It is here so the two facts are asserted together rather than one of them
  // being true by luck.
  if (underscored.length > 0) {
    console.log('        ' + underscored.length + ' published path(s) start with an underscore and need .nojekyll: ' +
      underscored.join(', '));
  }

  return 'Jekyll is off at the root, and the split adds benchmarks/libvips/ under it';
});

// ---------------------------------------------------------------------------
// 7. the_article_states_the_encoding_claim_it_measures
//
// The article told a reader, in two places, that neither side encodes and that
// libviprs collects tiles in a MemorySink. The code has said the opposite since
// libviprs-bench#153 put both sides on the same codec: BENCH_TILE_FORMAT is
// TileFormat::Png, the sweep's three engines write through an FsSink under a
// real temp directory in DeepZoom layout, and every libvips path passes
// --suffix .png to dzsave, the in-process FFI one included. That is not a
// wording nit. A page that says the comparison excludes encode cost when it
// includes it changes how every number on it reads.
//
// The byte-identity guard above pins the article to one exact text, so this
// looks redundant. It is not. That one is anchored on a blob from before the
// split and is only as good as its anchor; this one says the thing that matters
// rather than the bytes that happen to say it, and it still holds the first
// time somebody edits the article on purpose.
//
// Goes red against: the text as it stood before this branch, against dropping
// the claim, against reintroducing the in-RAM sink or the raw tiles, and
// against the paragraph going back to arguing for an asymmetric sink three
// sentences before it describes a symmetric one.
// ---------------------------------------------------------------------------

// Phrases that described benchmark tiles landing anywhere but a real on-disk
// PNG sink, or argued for the asymmetric sink that put them there. Matched
// case-insensitively. The last one is the old opening of How We Tested, and it
// is safe to forbid because the sentence that replaced it reads "write to disk
// while the other holds tiles in RAM and you're measuring your SSD", which does
// not contain it.
const STALE_ENCODING_PHRASES = [
  'neither side encodes',
  'no encoding',
  'writes raw tiles',
  'raw tiles (no encoding)',
  '<code>memorysink</code>',
  'pure pyramid generation throughput',
  "write to disk and you're measuring your ssd",
];

// The claim itself, in both places it belongs. The first entry is
// TILE_ENCODING_CLAIM from libviprs-bench src/lib.rs, whole: the article
// carries that sentence verbatim, so there is no reason to check it in pieces.
// It used to be two fragments with `" under the same DeepZoom layout, so "`
// falling down the gap between them, which left the layout half of the claim
// resting on the byte-identity guard alone, and that one is a one-shot anchored
// on a pre-split blob.
const REQUIRED_ENCODING_PHRASES = [
  'every engine writes its tiles as PNG files to a real on-disk sink under the same DeepZoom ' +
    'layout, so neither side gets an in-RAM-sink or tile-codec advantage',
  '<code>--suffix .png</code>',
  '<code>FsSink</code>',
  'the encode cost is paid on both sides',
];

test('the_article_states_the_encoding_claim_it_measures', () => {
  const html = read(ARTICLE);
  const lower = html.toLowerCase();
  const lines = html.split('\n');

  const lineOf = (needle) => {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) return i + 1;
    }
    return 0;
  };

  const stale = STALE_ENCODING_PHRASES
    .filter((p) => lower.includes(p))
    .map((p) => '"' + p + '" at line ' + lineOf(p));
  assert(
    stale.length === 0,
    'the article still describes benchmark tiles landing somewhere they do not:\n  ' + stale.join('\n  ') +
      '\nBoth sides encode PNG to a real on-disk sink, and have since libviprs-bench#153.');

  const missing = REQUIRED_ENCODING_PHRASES.filter((p) => !html.includes(p));
  assert(
    missing.length === 0,
    'the article no longer carries the encoding claim it measures. Missing:\n  ' +
      missing.map((p) => '"' + p + '"').join('\n  ') +
      '\nThe canonical sentence is TILE_ENCODING_CLAIM in libviprs-bench src/lib.rs.');

  return 'both sides encode PNG to a real on-disk sink, and the page says so in both places';
});

// ---------------------------------------------------------------------------
// 8. the_comparison_pages_own_files_point_at_their_own_directory
//
// The article's stylesheet, its renderer and its editorial JSON carry the
// publishing instructions for this page, and libviprs-org has no README, so
// those comments are not commentary on the instructions, they are the
// instructions. They came across the move at full similarity with nothing
// edited inside them, which is what a move should do and is exactly why nothing
// noticed that several of them still named benchmarks/data, benchmarks/img and
// benchmarks/js.
//
// The failure that sets up is a quiet one. The next person refreshing the
// libvips figures drops the JSON and the SVGs at benchmarks/data and
// benchmarks/img, where the libviprs page lives and nothing reads them. The
// article goes on showing the old numbers. bench-drift stays green, because it
// reads benchmarks/libvips/data and that is still consistent with itself. Stale
// figures on a benchmarks page with every check passing.
//
// So every benchmarks/ path named anywhere under benchmarks/libvips/ has to be
// one of two things: somewhere inside this page's own directory, or the drift
// gate at benchmarks/tools/, which genuinely does sit a level up and is shared.
//
// Goes red against: the tree as it stood before this commit, and against any
// file here that later names a sibling page's directory.
// ---------------------------------------------------------------------------

const ARTICLE_DIR = path.join(ROOT, 'benchmarks', 'libvips');

// The only two first segments a benchmarks/ path in this page's own files may
// have. Anything else is a path into somebody else's page.
const OWN_BENCHMARK_DIRS = new Set(['libvips', 'tools']);

test('the_comparison_pages_own_files_point_at_their_own_directory', () => {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  })(ARTICLE_DIR);

  assert(files.length >= 10, 'only ' + files.length + ' file(s) under benchmarks/libvips/, so this check is looking at almost nothing');

  const findings = [];
  let checked = 0;
  for (const full of files) {
    const text = fs.readFileSync(full, 'utf8');
    // The `*` rather than `+` matters: a bare "benchmarks/" with nothing after
    // it is a stale reference too, and the greedy form would not see it.
    const re = /benchmarks\/([A-Za-z0-9_.\-]*)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      checked++;
      if (OWN_BENCHMARK_DIRS.has(m[1])) continue;
      findings.push(
        path.relative(ROOT, full) + ':' + (text.slice(0, m.index).split('\n').length) +
        '  "' + m[0] + '"');
    }
  }

  assert(
    findings.length === 0,
    findings.length + ' path(s) under benchmarks/libvips/ naming a directory this page does not own:\n  ' +
      findings.join('\n  ') +
      '\nThese comments are the publishing instructions for this page, since the repo has no README. ' +
      'A republish that follows them lands the data where nothing reads it and every check stays green.');

  return checked + ' benchmarks/ path reference(s) across ' + files.length + ' file(s), all inside this page or the shared drift gate';
});

// ---------------------------------------------------------------------------

const TOTAL = 8;
console.log('');
if (failures.length === 0) {
  console.log('ok: ' + TOTAL + ' site-split guard(s) passed');
  process.exit(0);
}
console.error(failures.length + ' guard(s) failed: ' + failures.map((f) => f.name).join(', '));
process.exit(1);
