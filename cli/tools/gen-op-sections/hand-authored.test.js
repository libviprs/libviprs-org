#!/usr/bin/env node
/* libviprs-org/cli/tools/gen-op-sections/hand-authored.test.js
 *
 * Two-sided guard on the HAND_AUTHORED set.
 *
 * gen-op-sections drops every command named in HAND_AUTHORED from the
 * generated fragment, on the understanding that cli/index.html carries a
 * hand-written <h2 id="<name>"> section for it instead. Nothing checks that
 * the hand-written section actually exists, so the two halves can fall out of
 * step in either direction and the page still builds:
 *
 *   * name in HAND_AUTHORED, no section in index.html
 *       -> the command is filtered out of the generated reference and never
 *          appears anywhere. It disappears from the site silently.
 *   * section in index.html, name not in HAND_AUTHORED
 *       -> once the command reaches sample-dump.json the generator renders a
 *          second <h2> with the same id, and duplicate ids break every
 *          #<name> deep link on the page.
 *
 * This test fails on both. It reads only committed files and mutates nothing.
 *
 * It also checks a third thing, which only became checkable once
 * __dump-commands learned to recurse (libviprs/libviprs-cli#54). A command
 * group's subcommands are hand-authored as <h3 id="<cmd>-<sub>"> inside the
 * group's section, and the dump now lists them, so the two can be compared: a
 * subcommand added upstream with no section, or a section for one that no
 * longer exists, both fail here. Before the dump recursed there was nothing to
 * compare against and the group's four subcommands were documented by hand with
 * no gate behind them at all.
 *
 * Usage:
 *   node cli/tools/gen-op-sections/hand-authored.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { HAND_AUTHORED } = require('./index.js');

const HERE = __dirname;
const INDEX_HTML = path.join(HERE, '..', '..', 'index.html');
const DUMP_JSON = path.join(HERE, 'sample-dump.json');
const GENERATED_MARKER = '<div id="generated-op-sections">';

// Every `<h2 id="...">` heading, with its offset, so the generated region can
// be told apart from the hand-authored one by position.
function collectH2Ids(html) {
  const re = /<h2\s+id="([^"]+)"/g;
  const found = [];
  let m;
  while ((m = re.exec(html)) !== null) found.push({ id: m[1], at: m.index });
  return found;
}

// Every `<h3 id="...">` heading before `limit`, which is where a command
// group's subcommand sections live.
function collectH3Ids(html, limit) {
  const re = /<h3\s+id="([^"]+)"/g;
  const found = [];
  let m;
  while ((m = re.exec(html)) !== null && m.index < limit) found.push(m[1]);
  return found;
}

function main() {
  const failures = [];

  // Positive control. An empty set would make every check below pass without
  // inspecting anything, so a guard that cannot fail is itself a failure.
  if (!(HAND_AUTHORED instanceof Set)) {
    console.error('FAIL: gen-op-sections/index.js does not export HAND_AUTHORED as a Set');
    process.exit(1);
  }
  if (HAND_AUTHORED.size === 0) {
    console.error('FAIL: HAND_AUTHORED is empty — this guard would pass vacuously');
    process.exit(1);
  }

  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const markerAt = html.indexOf(GENERATED_MARKER);
  if (markerAt < 0) {
    console.error(`FAIL: ${GENERATED_MARKER} not found in cli/index.html — cannot tell the hand-authored region from the generated one`);
    process.exit(1);
  }

  const all = collectH2Ids(html);
  const handRegion = all.filter((h) => h.at < markerAt);

  // Second positive control: the parse has to see the sections that are
  // already there. A regex that matches nothing must not read as "all clean".
  if (handRegion.length === 0) {
    console.error('FAIL: no <h2 id="..."> headings found before the generated-op-sections container — the parse is broken');
    process.exit(1);
  }

  const handIds = new Map();
  for (const h of handRegion) handIds.set(h.id, (handIds.get(h.id) || 0) + 1);

  // Direction 1: declared hand-authored, so a section must exist.
  for (const name of [...HAND_AUTHORED].sort()) {
    const count = handIds.get(name) || 0;
    if (count === 0) {
      failures.push(`'${name}' is in HAND_AUTHORED but cli/index.html has no hand-authored <h2 id="${name}"> section — the command is filtered out of the generated reference and appears nowhere on the site`);
    } else if (count > 1) {
      failures.push(`'${name}' has ${count} <h2 id="${name}"> headings in the hand-authored region — duplicate ids break the #${name} deep link`);
    }
  }

  // Direction 2: a hand-authored section must be declared, or the generator
  // will render a duplicate of it as soon as the dump gains the command.
  for (const id of [...handIds.keys()].sort()) {
    if (!HAND_AUTHORED.has(id)) {
      failures.push(`cli/index.html hand-authors <h2 id="${id}"> but '${id}' is not in HAND_AUTHORED (cli/tools/gen-op-sections/index.js) — the generator will emit a second section with the same id`);
    }
  }

  // Direction 3: every subcommand the dump lists under a hand-authored command
  // needs its own <h3 id="<cmd>-<sub>">, and vice versa.
  const dump = JSON.parse(fs.readFileSync(DUMP_JSON, 'utf8'));
  const h3Ids = new Set(collectH3Ids(html, markerAt));
  let groupsChecked = 0;
  for (const cmd of (dump.commands || [])) {
    if (!HAND_AUTHORED.has(cmd.name)) continue;
    const subs = (cmd.subcommands || []).map((s2) => s2.name).sort();
    if (!subs.length) continue;
    groupsChecked += 1;
    for (const sub of subs) {
      if (!h3Ids.has(`${cmd.name}-${sub}`)) {
        failures.push(`'${cmd.name} ${sub}' is in sample-dump.json but cli/index.html has no <h3 id="${cmd.name}-${sub}"> section — the subcommand is documented nowhere, and nothing else on the site can reach it`);
      }
    }
    for (const id of [...h3Ids].sort()) {
      if (!id.startsWith(`${cmd.name}-`)) continue;
      const sub = id.slice(cmd.name.length + 1);
      if (!subs.includes(sub)) {
        failures.push(`cli/index.html documents <h3 id="${id}"> but '${sub}' is not a subcommand of '${cmd.name}' in sample-dump.json — either it was renamed upstream or the section is stale`);
      }
    }
  }
  // Positive control: if no hand-authored command has subcommands, direction 3
  // inspected nothing, and a vacuous pass must not read as a clean one.
  if (groupsChecked === 0) {
    console.error('FAIL: no hand-authored command in sample-dump.json has any subcommands — direction 3 checked nothing');
    console.error('      (regenerate sample-dump.json from `viprs __dump-commands --json`; the dump has to recurse)');
    process.exit(1);
  }

  console.log(`hand-authored guard: ${HAND_AUTHORED.size} declared name(s), ${handRegion.length} hand-authored <h2 id> section(s) in cli/index.html, ${groupsChecked} command group(s) checked against the dump`);
  for (const name of [...HAND_AUTHORED].sort()) {
    const ok = (handIds.get(name) || 0) === 1;
    console.log(`${ok ? '\x1b[32mOK    \x1b[0m' : '\x1b[31mBROKEN\x1b[0m'} ${name}`);
  }
  console.log('');

  if (failures.length) {
    console.error(`${failures.length} hand-authored/generated mismatch(es):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error('\nEither write the <h2 id="..."> section in cli/index.html, or drop the name from');
    console.error('HAND_AUTHORED in cli/tools/gen-op-sections/index.js. The two have to agree.');
    process.exit(1);
  }

  console.log(`ok: HAND_AUTHORED and cli/index.html agree on all ${HAND_AUTHORED.size} hand-authored command(s)`);
  process.exit(0);
}

main();
