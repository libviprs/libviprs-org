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
 * And one for the correction that rode in with the move, because the article
 * described an encode cost it does not exclude:
 *
 *   7. the_article_states_the_encoding_claim_it_measures
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

  return levels + ' relative reference(s) gained a level and ' + DECLARED_EDITS.length +
    ' declared edit(s) applied; the rest of the file is byte for byte';
});

// ---------------------------------------------------------------------------
// 4. the_libviprs_page_publishes_no_number_that_is_not_generated
//
// Nothing goes on the libviprs page that is not generated from an archived run
// by digest, and there are no archived runs yet, so the placeholder carries no
// number at all. Digits inside markup are fine (an SVG path, a viewport meta);
// a digit a reader can see is not.
//
// Goes red against: a hand-written figure in the prose, a table of any kind, or
// a chart image dropped in ahead of K2.4.
// ---------------------------------------------------------------------------

function visibleText(html) {
  let t = links.markupOnly(html);
  t = t.replace(/<[^>]*>/g, ' ');
  t = t.replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

test('the_libviprs_page_publishes_no_number_that_is_not_generated', () => {
  const html = read(PLACEHOLDER);

  assert(!/<table\b/i.test(html), 'the libviprs placeholder carries a <table>, and every number on that page has to come from an archived run');
  assert(!/<canvas\b/i.test(html), 'the libviprs placeholder carries a <canvas>, so something is being charted before there is a run to chart');
  const charts = (html.match(/<img\b[^>]*src="(?!https?:)[^"]*"/gi) || []);
  assert(charts.length === 0, 'the libviprs placeholder carries a local image, which on this site means a chart:\n  ' + charts.join('\n  '));

  const text = visibleText(html);
  assert(text.length > 80, 'the libviprs placeholder has almost no text on it (' + text.length + ' chars), so this test is checking nothing');

  const digits = text.match(/[^ ]*\d[^ ]*/g) || [];
  assert(
    digits.length === 0,
    'the libviprs placeholder shows ' + digits.length + ' number(s) a reader can see: ' + JSON.stringify(digits) + '\n' +
      'Nothing goes on that page that is not generated from an archived run by digest, and there are no ' +
      'archived runs yet.');
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
// the claim, and against reintroducing the in-RAM sink or the raw tiles.
// ---------------------------------------------------------------------------

// Phrases that described benchmark tiles landing anywhere but a real on-disk
// PNG sink. Matched case-insensitively.
const STALE_ENCODING_PHRASES = [
  'neither side encodes',
  'no encoding',
  'writes raw tiles',
  'raw tiles (no encoding)',
  '<code>memorysink</code>',
  'pure pyramid generation throughput',
];

// The claim itself, in both places it belongs. The canonical sentence is
// TILE_ENCODING_CLAIM in libviprs-bench src/lib.rs.
const REQUIRED_ENCODING_PHRASES = [
  'writes its tiles as PNG files to a real on-disk sink',
  'neither side gets an in-RAM-sink or tile-codec advantage',
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

const TOTAL = 7;
console.log('');
if (failures.length === 0) {
  console.log('ok: ' + TOTAL + ' site-split guard(s) passed');
  process.exit(0);
}
console.error(failures.length + ' guard(s) failed: ' + failures.map((f) => f.name).join(', '));
process.exit(1);
