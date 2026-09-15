#!/usr/bin/env node
/* libviprs-org/cli/tools/sync-pin.test.js
 *
 * Guard on the sync gate's pin, and on the sync job's shape.
 *
 * cli/rust/ is a frozen, byte-identical copy of libviprs-cli/src. The sync
 * gate is the only thing that says which libviprs-cli revision it is a copy
 * OF, and for a while it did not really say: the revision lived in the
 * CLI_COUNTERPART_REV repository variable, that variable was never set, and an
 * unset variable resolves to the empty string, which actions/checkout reads as
 * "the default branch". So the gate compared the frozen copy against whatever
 * libviprs-cli main was that morning. On top of that the checkout carried
 * continue-on-error and the assertion was guarded on the checkout's outcome,
 * so a checkout that failed for any reason produced a ::warning:: and a green
 * job.
 *
 * The pin now lives in cli/rust/COUNTERPART_REV, a committed file that moves
 * in the same PR as the re-synced copy. This test fails if the pin is
 * malformed, or if the sync job stops reading it, or if the skip-green shape
 * comes back. It reads only committed files and mutates nothing.
 *
 * It also guards every credential the workflows read, against the inventory in
 * .github/workflow-inputs.json (libviprs-org#72). That is here rather than in a
 * file of its own for a mechanical reason: adding a job to ci.yml, or changing
 * the `run:` text of a step in one of the jobs the pre-commit hook mirrors,
 * reddens the Hook Mirror guard in libviprs-tests until install-hooks.sh is
 * changed in the same wave. This file is already what `Assert the pin is well
 * formed and this job actually reads it` runs, so the rules below reach CI
 * without a single character of ci.yml's `run:` moving.
 *
 * Usage:
 *   node cli/tools/sync-pin.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PIN_PATH = path.join(ROOT, 'cli', 'rust', 'COUNTERPART_REV');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');

// The `sync:` job block: from the job key at two-space indent to the next key
// at that indent. Returned with its own text so every assertion below is
// scoped to this job and cannot accidentally match another one.
function syncJobBlock(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^ {2}sync:\s*$/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z_][A-Za-z0-9_-]*:/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

// ---------------------------------------------------------------------------
// The credentials the workflows read (libviprs-org#72)
// ---------------------------------------------------------------------------
//
// `sync` used to check libviprs-cli out with
// `token: ${{ secrets.SYNC_CLI_TOKEN || github.token }}`, and SYNC_CLI_TOKEN had
// never been created. Every run resolved it to github.token, libviprs-cli is
// public, so the checkout worked and nothing was ever reported. The line read as
// though the private-repo path was configured and it was not.
//
// Nothing could have caught that from a run, because a run cannot see it: the
// checkout step prints `token: ***` either way. So the check is on the text, and
// the thing it checks the text against is .github/workflow-inputs.json, which a
// person has to edit to add a name. That is the review moment #72 went through
// without: writing `secrets.FOO` is free, and writing down what FOO is and
// whether it is set is where you notice it is not.
//
// Every assertion below is reached through analyseCredentials(), which takes its
// workflows and its inventory as arguments. main() hands it the real ones. The
// mutation table at the bottom hands it fabricated ones, so every rule is proved
// to fire on the shape it exists for, on every run, rather than being believed.

const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const INVENTORY = path.join(ROOT, '.github', 'workflow-inputs.json');

// The platform's own credential under both its spellings. It always exists, so
// it is the one name that needs no entry, and an entry for it would be a
// declaration that can never be wrong.
const BUILTIN = new Set(['GITHUB_TOKEN']);

const REFERENCE = /\b(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** Every `secrets.X` / `vars.X` in one workflow, with the line it sits on. */
function referencesIn(name, text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    // A commented-out line is prose, not a read. The guard would otherwise
    // fail on the paragraph in ci.yml that explains this very rule.
    if (line.trim().startsWith('#')) return;
    for (const m of line.matchAll(REFERENCE)) {
      out.push({
        file: name,
        line: i + 1,
        scope: m[1],
        key: m[2],
        text: line.trim(),
        // `secrets.X || y` is the shape that degrades in silence. Read it off
        // the same line rather than the whole expression: every fallback in
        // this repo is written on one line and a multi-line one would show up
        // as a plain read, which is the stricter verdict.
        fallback: new RegExp(`${m[1]}\\.${m[2]}\\s*\\|\\|`).test(line),
      });
    }
  });
  return out;
}

/**
 * The `run:` body of a named step, or null.
 *
 * Structural, not a substring sweep of the file: it finds the `- name:` line,
 * takes the block up to the next step at the same indent, and returns the part
 * of it under `run:`. A step whose announcement lives in a neighbouring step
 * therefore does not count, which is the point — the earlier guards on these
 * hooks asserted by substring and stayed green after the behaviour they named
 * had been deleted (libviprs/libviprs#695).
 */
function stepRun(text, stepName) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (at < 0) return null;
  const indent = lines[at].length - lines[at].trimStart().length;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    const ind = l.length - l.trimStart().length;
    if (ind <= indent && l.trim().startsWith('- ')) { end = i; break; }
    if (ind < indent) { end = i; break; }
  }
  const block = lines.slice(at, end);
  const runAt = block.findIndex((l) => /^\s*run:\s*\|?\s*$|^\s*run:\s*\S/.test(l));
  return runAt < 0 ? null : block.slice(runAt).join('\n');
}

/** How many steps a workflow has, so a parse that reads nothing cannot pass. */
function stepCount(text) {
  return text.split('\n').filter((l) => /^\s*- (name|uses):/.test(l)).length;
}

/**
 * The whole rule set, as a pure function of its inputs.
 *
 * `workflows` is [{ name, text }], `inventory` is the parsed JSON. Returns the
 * list of problems, empty when the tree is clean.
 */
function analyseCredentials(workflows, inventory) {
  const failures = [];
  const declared = {
    secrets: inventory.secrets || {},
    vars: inventory.vars || {},
  };

  // Positive controls first. Both of the checks below are "nothing is wrong"
  // assertions, and both are satisfied by reading nothing at all.
  if (workflows.length === 0) {
    return ['no workflow files were read, so every credential check below would pass on an empty set'];
  }
  const refs = workflows.flatMap((w) => referencesIn(w.name, w.text));
  const declaredCount =
    Object.keys(declared.secrets).length + Object.keys(declared.vars).length;
  if (refs.length === 0 && declaredCount === 0) {
    return [
      'the workflows read no secrets or variables and the inventory declares none. ' +
        'That is either true or the scanner has stopped matching, and the two look ' +
        'identical from here. If it is true, delete this check rather than leave it ' +
        'passing on nothing.',
    ];
  }

  const seen = new Set();

  for (const ref of refs) {
    const where = `${ref.file}:${ref.line}`;
    if (BUILTIN.has(ref.key)) {
      if (declared[ref.scope][ref.key]) {
        failures.push(
          `${ref.scope}.${ref.key} is the platform's own and always exists, so the entry for it in .github/workflow-inputs.json is a declaration that can never be wrong. Drop it.`
        );
      }
      seen.add(`${ref.scope}.${ref.key}`);
      continue;
    }

    const entry = declared[ref.scope][ref.key];
    if (!entry) {
      failures.push(
        `${where} reads ${ref.scope}.${ref.key}, which is not declared in .github/workflow-inputs.json.\n` +
          `      ${ref.text}\n` +
          `      Add an entry saying what it is and whether it is set. If it is not set and ` +
          `nothing sets it, the reference is decorative and should go: that is libviprs-org#72, ` +
          `where a token fallback to a secret nobody had created read as a configured private-repo path.`
      );
      continue;
    }
    seen.add(`${ref.scope}.${ref.key}`);

    if (entry.kind === 'required' && ref.fallback) {
      failures.push(
        `${where} reads ${ref.scope}.${ref.key} as a \`||\` fallback, and it is declared \`required\`.\n` +
          `      ${ref.text}\n` +
          `      A required credential must be read plainly, so that a run without it fails on the ` +
          `spot. With the fallback the step succeeds doing something else, and only the case that ` +
          `needs the credential ever finds out.`
      );
    }

    if (ref.fallback && entry.kind !== 'required') {
      if (ref.scope === 'secrets' && entry.kind !== 'optional-announced') {
        failures.push(
          `${where} reads secrets.${ref.key} as a \`||\` fallback, and it is declared \`${entry.kind}\`.\n` +
            `      A secret fallback is invisible in the log — the step prints \`token: ***\` on either ` +
            `route — so it has to be \`optional-announced\` and say in the log which route it took.`
        );
      }
      if (ref.scope === 'vars' && entry.kind !== 'optional-visible') {
        failures.push(
          `${where} reads vars.${ref.key} as a \`||\` fallback, and it is declared \`${entry.kind}\`.`
        );
      }
    }

    if (entry.kind === 'optional-announced') {
      const wf = workflows.find((w) => w.name === ref.file);
      if (stepCount(wf.text) === 0) {
        failures.push(
          `${ref.file} parsed to zero steps, so the announcement check for secrets.${ref.key} would pass without looking at anything`
        );
      } else {
        const run = entry.announced_by ? stepRun(wf.text, entry.announced_by) : null;
        if (!entry.announced_by) {
          failures.push(
            `secrets.${ref.key} is declared \`optional-announced\` and names no \`announced_by\` step`
          );
        } else if (run === null) {
          failures.push(
            `secrets.${ref.key} names \`${entry.announced_by}\` as the step that says which route a run took, and ${ref.file} has no step by that name with a \`run:\`. Either it was renamed and the entry did not follow, or the announcement is gone and the fallback is silent again.`
          );
        } else {
          if (!run.includes(ref.key)) {
            failures.push(
              `the step \`${entry.announced_by}\` in ${ref.file} never mentions ${ref.key}, so it cannot be telling anyone which route the run took`
            );
          }
          if (!run.includes('::warning::')) {
            failures.push(
              `the step \`${entry.announced_by}\` in ${ref.file} does not emit a \`::warning::\`, so a run on the fallback route says so in ordinary log output that nobody reads. The fallback arm is the one worth annotating.`
            );
          }
        }
      }
    }

    if (!entry.why || (Array.isArray(entry.why) ? entry.why.join('') : entry.why).trim() === '') {
      failures.push(
        `${ref.scope}.${ref.key} is declared with no \`why\`. The entry exists to be read by the next person, and an entry that says nothing is worse than no entry.`
      );
    }
  }

  // A declaration nothing reads is a hole with a reassuring comment over it,
  // which is the fourth thing the hook-mirror guard in libviprs-tests checks
  // for the same reason.
  for (const scope of ['secrets', 'vars']) {
    for (const key of Object.keys(declared[scope])) {
      if (!seen.has(`${scope}.${key}`)) {
        failures.push(
          `.github/workflow-inputs.json declares ${scope}.${key} and no workflow reads it. Either the reference was removed and the entry should follow, or it was renamed.`
        );
      }
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// The mutation table for the rules above
// ---------------------------------------------------------------------------
//
// Each row is a tree analyseCredentials() is supposed to have an opinion about.
// They run on every invocation, because a mutation row that is not run is
// indistinguishable from one that passed. The last row is the negative: a tree
// the guard must NOT complain about, so that "everything fails" cannot be
// mistaken for "the rules work".

const ANNOUNCE_STEP = `      - name: Say the route
        run: |
          if [ -n "\${TOK:-}" ]; then
            echo "PAT route"
          else
            echo "::warning::TOK is not set, so this run falls back to GITHUB_TOKEN"
          fi
`;

function wf(name, body) {
  return { name, text: `name: x\njobs:\n  j:\n    steps:\n${body}` };
}

const MUTATIONS = [
  {
    row: 'a token fallback to an undeclared secret (the literal #72 shape)',
    workflows: [wf('ci.yml', '      - uses: actions/checkout@v4\n        with:\n          token: ${{ secrets.SYNC_CLI_TOKEN || github.token }}\n')],
    inventory: { secrets: {}, vars: {} },
    expect: /not declared in .github\/workflow-inputs.json/,
  },
  {
    row: 'an undeclared secret read plainly',
    workflows: [wf('ci.yml', '      - uses: actions/checkout@v4\n        with:\n          token: ${{ secrets.NOPE }}\n')],
    inventory: { secrets: {}, vars: {} },
    expect: /reads secrets.NOPE, which is not declared/,
  },
  {
    row: 'an undeclared repository variable (the #63 shape)',
    workflows: [wf('ci.yml', '      - uses: actions/checkout@v4\n        with:\n          ref: ${{ vars.SOME_REV || steps.pin.outputs.rev }}\n')],
    inventory: { secrets: {}, vars: {} },
    expect: /reads vars.SOME_REV, which is not declared/,
  },
  {
    row: 'a `required` secret read as a `||` fallback',
    workflows: [wf('ci.yml', '      - uses: actions/checkout@v4\n        with:\n          token: ${{ secrets.TOK || github.token }}\n')],
    inventory: { secrets: { TOK: { kind: 'required', why: 'w' } }, vars: {} },
    expect: /declared `required`/,
  },
  {
    row: 'an `optional-announced` secret whose announcing step is not there',
    workflows: [wf('ci.yml', '      - uses: actions/checkout@v4\n        with:\n          token: ${{ secrets.TOK || github.token }}\n')],
    inventory: { secrets: { TOK: { kind: 'optional-announced', announced_by: 'Say the route', why: 'w' } }, vars: {} },
    expect: /has no step by that name/,
  },
  {
    row: 'an `optional-announced` secret whose step exists but emits no ::warning::',
    workflows: [wf('ci.yml', '      - uses: actions/checkout@v4\n        with:\n          token: ${{ secrets.TOK || github.token }}\n      - name: Say the route\n        run: echo "TOK route chosen"\n')],
    inventory: { secrets: { TOK: { kind: 'optional-announced', announced_by: 'Say the route', why: 'w' } }, vars: {} },
    expect: /does not emit a `::warning::`/,
  },
  {
    row: 'an `optional-announced` secret whose step never names it',
    workflows: [wf('ci.yml', '      - uses: actions/checkout@v4\n        with:\n          token: ${{ secrets.TOK || github.token }}\n      - name: Say the route\n        run: echo "::warning::on the fallback route"\n')],
    inventory: { secrets: { TOK: { kind: 'optional-announced', announced_by: 'Say the route', why: 'w' } }, vars: {} },
    expect: /never mentions TOK/,
  },
  {
    row: 'a declaration no workflow reads',
    workflows: [wf('ci.yml', '      - uses: actions/checkout@v4\n')],
    inventory: { secrets: { GHOST: { kind: 'required', why: 'w' } }, vars: {} },
    expect: /declares secrets.GHOST and no workflow reads it/,
  },
  {
    row: 'a declaration with an empty `why`',
    workflows: [wf('ci.yml', '      - uses: actions/checkout@v4\n        with:\n          token: ${{ secrets.TOK }}\n')],
    inventory: { secrets: { TOK: { kind: 'required', why: '  ' } }, vars: {} },
    expect: /declared with no `why`/,
  },
  {
    row: 'an entry for the platform\'s own GITHUB_TOKEN',
    workflows: [wf('ci.yml', '      - uses: actions/checkout@v4\n        with:\n          token: ${{ secrets.GITHUB_TOKEN }}\n')],
    inventory: { secrets: { GITHUB_TOKEN: { kind: 'required', why: 'w' } }, vars: {} },
    expect: /can never be wrong/,
  },
  {
    row: 'nothing read and nothing declared (a scanner that has stopped matching)',
    workflows: [wf('ci.yml', '      - uses: actions/checkout@v4\n')],
    inventory: { secrets: {}, vars: {} },
    expect: /passing on nothing/,
  },
  {
    row: 'NEGATIVE — a correctly declared announced fallback, plus the builtin, must not fail',
    workflows: [wf('ci.yml', '      - uses: actions/checkout@v4\n        with:\n          token: ${{ secrets.TOK || github.token }}\n' + ANNOUNCE_STEP + '      - uses: actions/setup-node@v4\n        with:\n          token: ${{ secrets.GITHUB_TOKEN }}\n')],
    inventory: { secrets: { TOK: { kind: 'optional-announced', announced_by: 'Say the route', why: 'w' } }, vars: {} },
    expect: null,
  },
];

function runMutations() {
  const bad = [];
  for (const m of MUTATIONS) {
    const got = analyseCredentials(m.workflows, m.inventory);
    const joined = got.join('\n');
    if (m.expect === null) {
      if (got.length !== 0) {
        bad.push(`  ROW NOT CLEAN  ${m.row}\n      guard said: ${joined}`);
      } else {
        console.log(`  caught (clean) ${m.row}`);
      }
      continue;
    }
    if (!m.expect.test(joined)) {
      bad.push(
        `  ROW NOT CAUGHT ${m.row}\n      expected /${m.expect.source}/, guard said: ${joined || '(nothing)'}`
      );
    } else {
      console.log(`  caught         ${m.row}`);
    }
  }
  return bad;
}

function main() {
  const failures = [];

  // --- the pin itself ------------------------------------------------------
  if (!fs.existsSync(PIN_PATH)) {
    console.error(`FAIL: ${path.relative(ROOT, PIN_PATH)} does not exist — the sync gate has nothing to pin against`);
    process.exit(1);
  }
  const raw = fs.readFileSync(PIN_PATH, 'utf8');
  const rev = raw.trim();
  if (!/^[0-9a-f]{40}$/.test(rev)) {
    failures.push(`cli/rust/COUNTERPART_REV is not a 40-character lowercase commit sha: ${JSON.stringify(raw)}`);
  }
  if (raw.trim().split(/\s+/).length !== 1) {
    failures.push('cli/rust/COUNTERPART_REV holds more than one token; it must be exactly one commit sha');
  }

  // --- the job that consumes it -------------------------------------------
  const yaml = fs.readFileSync(WORKFLOW, 'utf8');
  const block = syncJobBlock(yaml);
  if (block === null) {
    console.error('FAIL: no `sync:` job found in .github/workflows/ci.yml');
    process.exit(1);
  }
  // Positive control. If the block extraction silently returned the wrong
  // slice, every "must not contain" check below would pass for the wrong
  // reason, so anchor on something the job certainly has.
  if (!block.includes('repository: libviprs/libviprs-cli')) {
    console.error('FAIL: the extracted `sync:` job does not check out libviprs/libviprs-cli — the block extraction is wrong, not the job');
    process.exit(1);
  }
  if (!block.includes('sync-cli-src.sh --check')) {
    failures.push('the sync job no longer runs cli/tools/sync-cli-src.sh --check');
  }
  // Reading the path is not the same as mentioning it. The job's own error
  // message names the file too, and a first cut of this check passed with the
  // actual read pointed at a different filename because the message still
  // matched. So require a shell redirect FROM the file, and separately require
  // the checkout to consume what that step produced.
  if (!/<\s*\S*cli\/rust\/COUNTERPART_REV/.test(block)) {
    failures.push('the sync job never reads cli/rust/COUNTERPART_REV (no shell redirect from it), so the committed pin is decorative');
  }
  if (!/ref:\s*\$\{\{[^}]*steps\.pin\.outputs\.rev/.test(block)) {
    failures.push('the libviprs-cli checkout does not use steps.pin.outputs.rev as its ref, so the pin is resolved and then ignored');
  }

  // The skip-green shape, in the two places it lived.
  const checkoutIdx = block.indexOf('id: checkout_cli');
  if (checkoutIdx >= 0) {
    // continue-on-error anywhere in the checkout step turns a failed checkout
    // into a green job again. The advisory step at the end of the job is
    // allowed to carry it, so scope the search to the checkout step.
    const stepEnd = block.indexOf('\n      - name:', checkoutIdx);
    const stepText = block.slice(checkoutIdx, stepEnd < 0 ? block.length : stepEnd);
    if (stepText.includes('continue-on-error')) {
      failures.push('the libviprs-cli checkout step carries continue-on-error — a failed checkout would skip the gate green');
    }
  }
  if (block.includes("steps.checkout_cli.outcome")) {
    failures.push("the sync job still guards a step on steps.checkout_cli.outcome — that is the skip-green shape this gate lost once already");
  }

  console.log(`sync-pin guard: pin=${rev || '(unreadable)'}, sync job block ${block.split('\n').length} line(s)`);

  // --- the credentials the workflows read ---------------------------------
  const workflows = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8') }));
  const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));

  console.log(`credential guard: ${workflows.length} workflow file(s) — ${workflows.map((w) => w.name).join(', ')}`);
  const mutationFailures = runMutations();
  if (mutationFailures.length) {
    console.error('\nthe credential guard no longer catches what it exists to catch:');
    for (const f of mutationFailures) console.error(f);
    process.exit(1);
  }
  failures.push(...analyseCredentials(workflows, inventory));

  if (failures.length) {
    console.error(`\n${failures.length} problem(s) with the sync pin:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('ok: the pin is a commit sha, the sync job reads it, nothing in the job can skip green, and every credential the workflows read is declared');
  process.exit(0);
}

main();
