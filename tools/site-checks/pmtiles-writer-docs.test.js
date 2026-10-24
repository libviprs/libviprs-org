#!/usr/bin/env node
/* libviprs-org/tools/site-checks/pmtiles-writer-docs.test.js
 *
 * TEST: the_pmtiles_writer_flags_and_memory_contract_are_documented (#104)
 *
 * EPIC M (libviprs/libviprs#1135) shipped three `viprs pyramid` flags that
 * steer the bounded-memory PMTiles writer, and the site never picked them up.
 * Its fourth deliverable was "documentation on libviprs.org, covering the
 * writer's memory contract and its CLI reference". This holds the site to that.
 *
 * The flag list is not written down here. It is read out of the frozen copy of
 * the CLI source (cli/rust/pipeline.rs), from every field under
 * `help_heading = "PMTiles"`, so a fourth flag added upstream and re-synced
 * here turns this red until the page covers it. The numbers the page quotes
 * (the 520 byte floor, the 65 bytes a tile, the 8 MiB default) are checked the
 * same way: they have to still be stated in that source, so the page cannot
 * keep repeating a figure the CLI has stopped claiming.
 *
 * What it asserts, in cli/index.html (the reference):
 *
 *   1. each PMTiles flag has a <dt id="flag-NAME"> naming it, so the
 *      `https://libviprs.org/cli/#flag-NAME` links the CLI's own --help
 *      prints land somewhere
 *   2. each flag's <dd> links to the memory-contract section, and
 *      --pmtiles-layout's names both of its values
 *   3. a section with id="pmtiles-writer-memory" states the contract: peak
 *      memory independent of tile count and of distinct payload count; the
 *      window is a fixed capacity, so identical tiles further apart than it are
 *      stored twice; the floor, the per-tile cost and the default; why
 *      tile-id stays the default; what --ordered-emission costs
 *
 * and in cli.html, the older single-file reference, that each flag is listed.
 *
 * Plain Node, no dependency and no build step. Usage:
 *   node tools/site-checks/pmtiles-writer-docs.test.js   # exit 1 on any failure
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PIPELINE_RS = path.join(ROOT, 'cli', 'rust', 'pipeline.rs');
const REFERENCE = path.join(ROOT, 'cli', 'index.html');
const LEGACY = path.join(ROOT, 'cli.html');
const SECTION_ID = 'pmtiles-writer-memory';

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

// Every field under `help_heading = "PMTiles"` in the frozen pipeline.rs, as
// the flag clap derives from it (underscores become hyphens).
function pmtilesFlags(source) {
  const out = [];
  const re = /help_heading\s*=\s*"PMTiles"\)\]\s*\n\s*pub\(crate\)\s+(\w+)\s*:/g;
  let m;
  while ((m = re.exec(source)) !== null) out.push(m[1].replace(/_/g, '-'));
  return out;
}

// The <dd> that follows the <dt> whose id is flag-NAME, or null.
function flagEntry(html, name) {
  const dt = new RegExp('<dt\\b[^>]*\\bid="flag-' + name + '"[^>]*>([\\s\\S]*?)</dt>\\s*<dd>([\\s\\S]*?)</dd>').exec(html);
  return dt ? { dt: dt[1], dd: dt[2] } : null;
}

// The element with id=SECTION_ID, from its open tag to the next <h2.
function sectionText(html) {
  const open = html.search(new RegExp('<(h[23]|section|div)\\b[^>]*\\bid="' + SECTION_ID + '"'));
  if (open === -1) return null;
  const rest = html.slice(open + 1);
  const next = rest.search(/<h2\b/);
  return next === -1 ? rest : rest.slice(0, next);
}

const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

const source = read(PIPELINE_RS);
const flags = pmtilesFlags(source);
const reference = read(REFERENCE);

test('the_frozen_cli_source_names_the_three_epic_m_flags', () => {
  for (const f of ['pmtiles-layout', 'ordered-emission', 'dedupe-memory-bytes']) {
    assert(flags.includes(f), 'cli/rust/pipeline.rs has no "' + f + '" under help_heading "PMTiles"; found: ' + flags.join(', '));
  }
  return flags.map((f) => '--' + f).join(', ');
});

test('every_pmtiles_flag_has_an_anchored_entry_in_the_cli_reference', () => {
  const missing = flags.filter((f) => !flagEntry(reference, f));
  assert(missing.length === 0,
    'cli/index.html has no <dt id="flag-NAME"> for: ' + missing.map((f) => '--' + f).join(', '));
});

test('every_pmtiles_flag_entry_links_to_the_memory_contract', () => {
  const bad = flags.filter((f) => {
    const e = flagEntry(reference, f);
    return !e || e.dd.indexOf('href="#' + SECTION_ID + '"') === -1;
  });
  assert(bad.length === 0,
    'these flag entries do not link to #' + SECTION_ID + ': ' + bad.map((f) => '--' + f).join(', '));
});

test('pmtiles_layout_names_both_of_its_values', () => {
  const e = flagEntry(reference, 'pmtiles-layout');
  assert(e, 'no entry for --pmtiles-layout in cli/index.html');
  const text = plain(e.dd);
  for (const v of ['tile-id', 'arrival']) assert(text.includes(v), '--pmtiles-layout entry never mentions "' + v + '"');
  assert(/default/i.test(text) && /tile-id/.test(text), '--pmtiles-layout entry does not say tile-id is the default');
});

test('the_memory_contract_section_exists_and_states_the_contract', () => {
  const sec = sectionText(reference);
  assert(sec, 'cli/index.html has no element with id="' + SECTION_ID + '"');
  const text = plain(sec);
  const need = [
    [/independent of the (number of )?tiles|does not grow with the (number of )?tiles/i, 'peak memory does not grow with the tile count'],
    [/distinct payloads?/i, 'peak memory does not grow with the distinct payload count'],
    [/fixed[- ]capacity/i, 'the dedupe window is a fixed capacity'],
    [/stored twice/i, 'identical tiles further apart than the window are stored twice'],
    [/still (a )?correct|reads identically/i, 'the archive is still correct when that happens'],
    [/520/, 'the 520 byte floor'],
    [/65 bytes/, 'the 65 bytes a tile'],
    [/8 MiB/, 'the 8 MiB default'],
    [/byte-identical/i, 'what byte identity needs'],
    [/clustered/i, 'clustered'],
    [/--memory-limit/, 'that --memory-limit counts the extra memory'],
    [/--ordered-emission/, '--ordered-emission'],
    [/--pmtiles-layout/, '--pmtiles-layout'],
    [/--dedupe-memory-bytes/, '--dedupe-memory-bytes'],
  ];
  const missing = need.filter(([re]) => !re.test(text)).map(([, what]) => what);
  assert(missing.length === 0, 'the memory contract section does not say: \n  - ' + missing.join('\n  - '));
});

test('the_figures_the_page_quotes_are_still_the_cli_sources', () => {
  assert(/Below 520 bytes/.test(source), 'cli/rust/pipeline.rs no longer says the floor is 520 bytes; the page quotes it');
  assert(/About 65 bytes per distinct tile/.test(source), 'cli/rust/pipeline.rs no longer says 65 bytes per tile; the page quotes it');
  assert(/default is 8 MiB/.test(source), 'cli/rust/pipeline.rs no longer says the default is 8 MiB; the page quotes it');
});

test('the_legacy_cli_page_lists_each_pmtiles_flag', () => {
  const legacy = read(LEGACY);
  const missing = flags.filter((f) => !new RegExp('<dt>\\s*<code>--' + f + '\\b').test(legacy));
  assert(missing.length === 0, 'cli.html does not list: ' + missing.map((f) => '--' + f).join(', '));
});

if (failures.length) {
  console.log('\n' + failures.length + ' failure(s)');
  process.exit(1);
}
console.log('\nall pmtiles writer docs checks passed');
