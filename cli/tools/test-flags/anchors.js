#!/usr/bin/env node
/* libviprs-org/cli/tools/test-flags/anchors.js
 *
 * Flag-anchor test.
 *
 * The CLI `--help` doc comments in the frozen copy (cli/rust/main.rs) link to
 * the interactive page with fragments of the form:
 *
 *     https://libviprs.org/cli/#flag-<name>
 *
 * Those `#flag-<name>` anchors are generated CLIENT-SIDE by cli.js
 * (`dt.id = 'flag-' + flagName`) from the flag keys in
 * cli/js/snippets.generated.json. So a link only resolves if a flag whose key
 * is exactly `<name>` exists in that JSON. If a flag is renamed upstream and
 * the sync/regeneration is skipped, the JSON key and the `--help` link fall
 * out of step and the hyperlink silently 404s to nowhere on the page.
 *
 * This test fails if any `#flag-<name>` link in the frozen copy has no
 * matching flag key in snippets.generated.json. It reads only committed files;
 * it never regenerates or mutates anything.
 *
 * Usage:
 *   node cli/tools/test-flags/anchors.js            # report + exit 1 on any broken anchor
 *   node cli/tools/test-flags/anchors.js --json     # machine-readable
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_RS = path.join(ROOT, 'rust', 'main.rs');
const JSON_PATH = path.join(ROOT, 'js', 'snippets.generated.json');
const DUMP_PATH = path.join(ROOT, 'tools', 'gen-op-sections', 'sample-dump.json');

// Two distinct anchor schemes reach the page:
//   * `#flag-<name>`         — rendered CLIENT-SIDE by cli.js ONLY for the
//                              interactive `pyramid` command (dt.id = 'flag-'+key).
//   * `#<cmd>-flag-<long>`   — rendered by tools/gen-op-sections for every
//                              data-generated op command's flag rows.
// The op scheme is matched first (it is the more specific pattern) so a link
// like `#morph-flag-mask` is not mis-read as a pyramid `#flag-<name>`.
const OP_ANCHOR_RE = /#([a-z0-9][a-z0-9-]*)-flag-([a-z0-9][a-z0-9-]*)/g;
const PYRAMID_ANCHOR_RE = /#flag-([a-z0-9][a-z0-9-]*)/g;

// Collect both anchor schemes from `source`. Returns { pyramid: Map(name->[line]),
// op: Map("cmd/long"->{cmd,long,lines}) }. A span matched as an op anchor is
// removed from the line before the pyramid pass so it cannot double-count.
function collectAnchorRefs(source) {
  const pyramid = new Map();
  const op = new Map();
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let m;
    OP_ANCHOR_RE.lastIndex = 0;
    while ((m = OP_ANCHOR_RE.exec(line)) !== null) {
      // A pyramid anchor `#flag-<name>` must not be read as op cmd="flag".
      if (m[1] === 'flag') continue;
      const key = `${m[1]}/${m[2]}`;
      if (!op.has(key)) op.set(key, { cmd: m[1], long: m[2], lines: [] });
      op.get(key).lines.push(i + 1);
    }
    // Blank out op-anchor spans so the pyramid pass ignores their tail.
    line = line.replace(OP_ANCHOR_RE, (whole) => (whole.startsWith('#flag-') ? whole : ' '.repeat(whole.length)));
    PYRAMID_ANCHOR_RE.lastIndex = 0;
    while ((m = PYRAMID_ANCHOR_RE.exec(line)) !== null) {
      const name = m[1];
      if (!pyramid.has(name)) pyramid.set(name, []);
      pyramid.get(name).push(i + 1);
    }
  }
  return { pyramid, op };
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');

  const source = fs.readFileSync(MAIN_RS, 'utf8');
  const json = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

  // SCHEMA v2: flags are command-scoped. `#flag-<name>` anchors are rendered
  // ONLY for the interactive `pyramid` command, so scope the check to pyramid's
  // flag keys (a v1 flat document falls back to its top-level flags).
  let pyramidFlagKeys;
  if (json.commands && typeof json.commands === 'object') {
    const pyr = json.commands.pyramid || {};
    pyramidFlagKeys = new Set(Object.keys(pyr.flags || {}));
  } else {
    pyramidFlagKeys = new Set(Object.keys(json.flags || {}));
  }

  // Op-section `#<cmd>-flag-<long>` anchors resolve against the command dump
  // that tools/gen-op-sections renders from: cmd -> Set(flag long names).
  const opFlags = new Map();
  if (fs.existsSync(DUMP_PATH)) {
    const dump = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf8'));
    (dump.commands || []).forEach((c) => {
      opFlags.set(c.name, new Set((c.flags || []).map((f) => f.long)));
    });
  }

  const { pyramid, op } = collectAnchorRefs(source);

  const results = [];
  for (const [name, atLines] of pyramid) {
    results.push({ scheme: 'pyramid', label: `#flag-${name}`, lines: atLines, ok: pyramidFlagKeys.has(name) });
  }
  for (const [, ref] of op) {
    const known = opFlags.has(ref.cmd) && opFlags.get(ref.cmd).has(ref.long);
    results.push({ scheme: 'op', label: `#${ref.cmd}-flag-${ref.long}`, lines: ref.lines, ok: known });
  }
  results.sort((a, b) => a.label.localeCompare(b.label));

  const broken = results.filter((r) => !r.ok);

  if (asJson) {
    console.log(JSON.stringify({ total: results.length, broken, results }, null, 2));
    process.exit(broken.length ? 1 : 0);
  }

  const relMain = path.relative(process.cwd(), MAIN_RS);
  console.log(`flag-anchor test: ${results.length} anchor link(s) in ${relMain}`);
  console.log(`checked #flag-* against ${pyramidFlagKeys.size} pyramid flags; `
    + `#<cmd>-flag-* against ${opFlags.size} dump command(s)\n`);

  for (const r of results) {
    const tag = r.ok ? '\x1b[32mOK    \x1b[0m' : '\x1b[31mBROKEN\x1b[0m';
    console.log(`${tag} ${r.label}  (main.rs:${r.lines.join(',')})`);
  }
  console.log('');

  if (broken.length) {
    console.error(`${broken.length} / ${results.length} --help anchors point at a flag that does not exist:`);
    for (const r of broken) {
      const where = r.scheme === 'pyramid'
        ? 'no such pyramid flag key in snippets.generated.json'
        : 'no such command/flag in the op-command dump';
      console.error(`  - ${r.label} referenced at main.rs:${r.lines.join(',')} — ${where}`);
    }
    console.error('\nEither the flag was renamed and the source is stale (re-run cli/tools/sync-cli-src.sh');
    console.error('and commit the regenerated snippets.generated.json / dump), or the --help link is wrong.');
    process.exit(1);
  }

  console.log(`ok: all ${results.length} --help anchors resolve`);
  process.exit(0);
}

main();
