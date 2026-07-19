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

// Matches the fragment in links like
//   https://libviprs.org/cli/#flag-tile-size
// Anchor names are the client-side `flag-` + flagName, and flag names are
// kebab-case (lowercase letters, digits, dashes).
const ANCHOR_RE = /#flag-([a-z0-9][a-z0-9-]*)/g;

function collectAnchorRefs(source) {
  // name -> array of 1-based line numbers where it is referenced
  const refs = new Map();
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let m;
    ANCHOR_RE.lastIndex = 0;
    while ((m = ANCHOR_RE.exec(lines[i])) !== null) {
      const name = m[1];
      if (!refs.has(name)) refs.set(name, []);
      refs.get(name).push(i + 1);
    }
  }
  return refs;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');

  const source = fs.readFileSync(MAIN_RS, 'utf8');
  const json = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  // SCHEMA v2: flags are command-scoped. The `#flag-<name>` anchors the
  // interactive page renders come from the pyramid command. Fall back to a v1
  // (flat) document. Union all commands' flag keys so cross-command anchors
  // (if any) also resolve.
  var flagKeys;
  if (json.commands && typeof json.commands === 'object') {
    flagKeys = new Set();
    Object.keys(json.commands).forEach(function (name) {
      Object.keys((json.commands[name] && json.commands[name].flags) || {})
        .forEach(function (k) { flagKeys.add(k); });
    });
  } else {
    flagKeys = new Set(Object.keys(json.flags || {}));
  }

  const refs = collectAnchorRefs(source);
  const results = [];
  for (const [name, atLines] of refs) {
    results.push({ name, lines: atLines, ok: flagKeys.has(name) });
  }
  results.sort((a, b) => a.name.localeCompare(b.name));

  const broken = results.filter((r) => !r.ok);

  if (asJson) {
    console.log(JSON.stringify({ total: results.length, broken, results }, null, 2));
    process.exit(broken.length ? 1 : 0);
  }

  const relMain = path.relative(process.cwd(), MAIN_RS);
  const relJson = path.relative(process.cwd(), JSON_PATH);
  console.log(`flag-anchor test: ${results.length} \`#flag-*\` links in ${relMain}`);
  console.log(`checked against ${flagKeys.size} flags in ${relJson}\n`);

  for (const r of results) {
    const tag = r.ok ? '\x1b[32mOK    \x1b[0m' : '\x1b[31mBROKEN\x1b[0m';
    console.log(`${tag} #flag-${r.name}  (main.rs:${r.lines.join(',')})`);
  }
  console.log('');

  if (broken.length) {
    console.error(`${broken.length} / ${results.length} --help anchors point at a flag that does not exist in snippets.generated.json:`);
    for (const r of broken) {
      console.error(`  - #flag-${r.name} referenced at main.rs:${r.lines.join(',')} — no such flag key`);
    }
    console.error('\nEither the flag was renamed and the JSON is stale (re-run cli/tools/sync-cli-src.sh');
    console.error('and commit the regenerated snippets.generated.json), or the --help link is wrong.');
    process.exit(1);
  }

  console.log(`ok: all ${results.length} --help anchors resolve to a flag in snippets.generated.json`);
  process.exit(0);
}

main();
