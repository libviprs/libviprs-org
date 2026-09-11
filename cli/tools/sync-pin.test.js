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

  if (failures.length) {
    console.error(`\n${failures.length} problem(s) with the sync pin:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('ok: the pin is a commit sha, the sync job reads it, and nothing in the job can skip green');
  process.exit(0);
}

main();
