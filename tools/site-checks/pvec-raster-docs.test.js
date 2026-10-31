#!/usr/bin/env node
/* libviprs-org/tools/site-checks/pvec-raster-docs.test.js
 *
 * TEST: the_pvec_raster_feature_page_is_on_the_site (libviprs/libviprs#1333)
 *
 * EPIC R-L (libviprs/libviprs#1329) lets libviprs put rasters into a PVec. Its fourth
 * deliverable is documentation on libviprs.org. This holds the feature page to that: a
 * section with id="pvec-raster" in index.html that
 *
 *   1. carries the producer rules table, with every rule id of the generated page
 *      (libviprs/docs/pvec-raster.md, between its producer-rules markers) when that page
 *      sits beside this repository, and at least the rows below when it does not
 *   2. points at ADR 0018 in libviprs/pvec and back at the generated page
 *   3. names the three commands
 *
 *   4. cli/index.html documents the three commands (flags, examples, the feature they need)
 *
 * Plain Node, no dependency and no build step. Usage:
 *   node tools/site-checks/pvec-raster-docs.test.js   # exit 1 on any failure
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };

const start = html.indexOf('<section id="pvec-raster">');
check(start !== -1, 'index.html has no <section id="pvec-raster">');
const end = start === -1 ? -1 : html.indexOf('</section>', start);
const section = start === -1 ? '' : html.slice(start, end);

// 1. the rules table
const ids = [...section.matchAll(/<tr><td><code>([a-z0-9-]+)<\/code><\/td>/g)].map((m) => m[1]);
check(ids.length >= 27, `the rules table has ${ids.length} rows, expected at least 27`);
check(new Set(ids).size === ids.length, 'a rule id appears twice');
for (const must of ['centring-off', 'overlap-0', 'composition-precondition', 'pdf-colour-and-mask-bake', 'nothing-dropped-silently']) {
  check(ids.includes(must), `the rules table has no row ${must}`);
}

const generated = path.resolve(root, '..', 'libviprs', 'docs', 'pvec-raster.md');
if (fs.existsSync(generated)) {
  const doc = fs.readFileSync(generated, 'utf8');
  const a = doc.indexOf('<!-- producer-rules:begin -->');
  const b = doc.indexOf('<!-- producer-rules:end -->');
  const docIds = [...doc.slice(a, b).matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
  check(JSON.stringify(docIds) === JSON.stringify(ids), 'the site table and docs/pvec-raster.md list different rules');
}

// 2. the pointers
check(section.includes('github.com/libviprs/pvec/blob/main/docs/adr/0018-raster-in-pvec.md'), 'the page does not link ADR 0018');
check(section.includes('github.com/libviprs/libviprs/blob/main/docs/pvec-raster.md'), 'the page does not link the generated page');

// 3. the commands
for (const cmd of ['viprs pyramid --storage pvec', 'viprs pmtiles to-pvec', 'viprs pvec rasters']) {
  check(section.includes(cmd), `the page does not name \`${cmd}\``);
}

// 4. the CLI reference (hand written: the snippet extractor does not read the
//    @doc-snippet slots in libviprs-cli's src/pvec_raster/imp.rs yet)
const cli = fs.readFileSync(path.join(root, 'cli', 'index.html'), 'utf8');
for (const id of ['pvec', 'pvec-pyramid', 'pvec-rasters', 'pmtiles-to-pvec']) {
  check(cli.includes(`id="${id}"`), `cli/index.html has no id="${id}"`);
}
for (const flag of ['--storage pvec', '--pvec-into', '--pixel-to-source', '--source-to-geo', '--geo-origin',
  '--geo-scale', '--affine', '--band', '--opacity', '--attribution', '--layer', '--drop-blanks',
  '--tile-size', '--json', '--tile']) {
  check(cli.includes(`<code>${flag}`) || cli.includes(`${flag}</code>`), `the CLI reference does not document ${flag}`);
}
check(/pvec-raster<\/code> feature/.test(cli), 'the CLI reference does not say the commands need the pvec-raster feature');
check(cli.includes('viprs pmtiles to-pvec') && cli.includes('viprs pvec rasters'), 'the CLI reference has no example of to-pvec and rasters');

if (failures.length) {
  for (const f of failures) console.error('FAIL: ' + f);
  process.exit(1);
}
console.log(`pvec raster page ok: ${ids.length} rules`);
