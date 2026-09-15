// Guards on benchmarks/tools/ingest.mjs.
//
// Each test names, in a comment, the wrong implementation it goes red against.
//
// The fixtures are real git repositories built in a temp directory around a
// real archived document taken from the pinned libviprs-bench revision, because
// the claim under test is about digests and a hand-written document cannot
// carry ones that verify. The canonicaliser and the importer config are copied
// out of that revision too, so nothing here is a second implementation of the
// thing it is checking.
//
// A missing libviprs-bench checkout FAILS. It does not skip. A capability skip
// is exactly the same colour as a pass, and this suite has nothing to say
// without the repository it reads from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyOrigin, readAtRev, readPin, BENCH, PIN_PATH, HISTORY_PATH } from './ingest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const INGEST = join(here, 'ingest.mjs');

/** The libviprs-bench checkout this suite reads its material from. */
const BENCH_DIR = resolve(
  process.env.BENCH_DIR ?? join(here, '..', '..', '..', 'libviprs-bench'),
);
if (!existsSync(join(BENCH_DIR, '.git'))) {
  throw new Error(
    `no libviprs-bench checkout at ${BENCH_DIR}. Set BENCH_DIR. This suite verifies digests ` +
      'against real archived documents and has nothing to check without them, so it fails here ' +
      'rather than skipping: a skip is the same colour as a pass.',
  );
}
const PINNED = readPin();

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A libviprs-bench-shaped repository holding one archived run and one history
 *  entry derived from it, with hooks to break exactly one thing. */
function fixtureBench({ document: mutateDocument, entry: mutateEntry, index: mutateIndex, config: mutateConfig, history: mutateHistory } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-fixture-'));
  mkdirSync(join(dir, 'tools', 'publish'), { recursive: true });
  mkdirSync(join(dir, 'tools', 'contract'), { recursive: true });

  writeFileSync(
    join(dir, BENCH.canonicaliser),
    readAtRev(BENCH_DIR, PINNED, BENCH.canonicaliser),
  );
  const config = JSON.parse(readAtRev(BENCH_DIR, PINNED, BENCH.config));
  writeFileSync(join(dir, BENCH.config), JSON.stringify(mutateConfig ? mutateConfig(config) : config));

  // The real thing: whichever run the pinned revision's own history carries.
  const realHistory = JSON.parse(readAtRev(BENCH_DIR, PINNED, BENCH.history));
  const source = realHistory[0];
  const realIndex = JSON.parse(readAtRev(BENCH_DIR, PINNED, BENCH.archiveIndex(source.family)));
  const row = realIndex.find((r) => r.runId === source.runId);
  const document = JSON.parse(readAtRev(BENCH_DIR, PINNED, BENCH.archiveFile(source.family, row.file)));

  const finalDocument = mutateDocument ? mutateDocument(document) : document;
  mkdirSync(join(dir, 'archive', source.family), { recursive: true });
  writeFileSync(
    join(dir, BENCH.archiveFile(source.family, row.file)),
    JSON.stringify(finalDocument),
  );
  const finalIndex = mutateIndex ? mutateIndex([{ ...row }]) : [{ ...row }];
  writeFileSync(join(dir, BENCH.archiveIndex(source.family)), JSON.stringify(finalIndex));

  const entry = mutateEntry ? mutateEntry(structuredClone(source)) : source;
  const history = mutateHistory ? mutateHistory([entry]) : [entry];
  writeFileSync(join(dir, BENCH.history), JSON.stringify(history));

  git(dir, 'init', '--quiet');
  git(dir, 'add', '-A');
  execFileSync(
    'git',
    [
      '-C', dir,
      '-c', 'user.email=fixture@example.invalid',
      '-c', 'user.name=fixture',
      'commit', '--quiet', '-m', 'fixture',
    ],
    { encoding: 'utf8' },
  );
  return { dir, rev: git(dir, 'rev-parse', 'HEAD'), source, document, row };
}

const verify = (fixture) => verifyOrigin({ benchDir: fixture.dir, rev: fixture.rev });

test('an untouched fixture verifies, which is the control every refusal below needs', async () => {
  // Without this every test in the file passes against a verifier that refuses
  // everything, and all of them would be proving the same nothing.
  const { refusals, configFaults } = await verify(fixtureBench());
  assert.deepEqual(configFaults, []);
  assert.deepEqual(refusals, []);
});

test('the real pinned revision verifies', async () => {
  // The other control, and the one that fails when the pin moves to a revision
  // whose history is not backed by its own archive. The fixtures above are
  // built by this file; this is the repository as it actually is.
  const { refusals, configFaults } = await verifyOrigin({ benchDir: BENCH_DIR, rev: PINNED });
  assert.deepEqual(configFaults, []);
  assert.deepEqual(refusals, []);
});

test('an entry no archived document supports is refused', async () => {
  // Red against a verifier that only compares the frozen copy with the pinned
  // file. That is the state the page was in: two entries whose run ids no
  // document in libviprs-bench/archive carried, and nothing that could notice.
  const { refusals } = await verify(
    fixtureBench({ entry: (e) => ({ ...e, runId: `${e.runId}-not-archived` }) }),
  );
  assert.equal(refusals.length, 1, refusals.join('\n'));
  assert.match(refusals[0], /no archived document at .* carries this run id/);
});

test('a document edited after it was filed is refused on the recomputed digests', async () => {
  // Red against matching the entry's integrity block to the index row and
  // stopping there. Both were written before the edit, so they agree with each
  // other and with nothing that is now in the file.
  const { refusals } = await verify(
    fixtureBench({
      document: (d) => {
        const copy = structuredClone(d);
        const cell = copy.cells.find((c) => Number.isFinite(c.median));
        cell.median = cell.median * 2;
        return copy;
      },
    }),
  );
  assert.ok(refusals.some((r) => /digests do not match the archived document/.test(r)), refusals.join('\n'));
});

test('an index row whose digest disagrees with the document is refused', async () => {
  // Red against recomputing the digests and never joining them to the index.
  // The index is what makes a run citable; a document that verifies against
  // itself and not against the archive is a file, not an archived run.
  const { refusals } = await verify(
    fixtureBench({ index: (rows) => rows.map((r) => ({ ...r, documentDigest: 'sha256:' + '0'.repeat(64) })) }),
  );
  assert.ok(refusals.some((r) => /the archive index records documentDigest/.test(r)), refusals.join('\n'));
});

test('an entry that relabels the run it came from is refused', async () => {
  // Red against trusting the entry's own account of the document. A page that
  // labels a debug run `release`, or an x86_64 run `aarch64`, is worse than a
  // page with nothing on it, because it reads as evidence.
  const { refusals } = await verify(
    fixtureBench({ entry: (e) => ({ ...e, host: { ...e.host, buildProfile: 'debug' } }) }),
  );
  assert.ok(
    refusals.some((r) => /host\.buildProfile is "debug" and the archived document's/.test(r)),
    refusals.join('\n'),
  );
});

test('an emulated run is refused even when its entry says otherwise', async () => {
  // Red against reading the verdict off the entry, which is why the document
  // and the entry disagree here rather than both being emulated: an
  // implementation that reads `entry.emulated` sees `false` and lets it
  // through, and the assertion is on the message so that the mirrored-facts
  // refusal underneath cannot stand in for the one that matters.
  const { refusals } = await verify(
    fixtureBench({
      document: (d) => {
        const copy = structuredClone(d);
        copy.provenance.emulated = true;
        return copy;
      },
    }),
  );
  // On the sentence the emulation rule alone produces, not on the value. The
  // mirrored-facts refusal underneath this one reads "the entry says emulated is
  // false and the archived document's provenance.emulated is true", which
  // contains the same words and would have let a verifier that reads the verdict
  // off the entry pass this test. It did, once.
  assert.ok(
    refusals.some((r) => /only an observed `false` may be published/.test(r)),
    refusals.join('\n'),
  );
});

test('an absent emulation verdict is refused, because an unobserved run is not a native one', async () => {
  // The numbers this page replaced were almost certainly Rosetta and nothing in
  // the artefact recorded it, so `absent` has to be its own refusal rather than
  // falling through the `!== false` test as if it had been observed.
  const { refusals } = await verify(
    fixtureBench({
      document: (d) => {
        const copy = structuredClone(d);
        delete copy.provenance.emulated;
        return copy;
      },
      entry: (e) => {
        const copy = { ...e };
        delete copy.emulated;
        return copy;
      },
    }),
  );
  assert.ok(refusals.some((r) => /provenance\.emulated is absent/.test(r)), refusals.join('\n'));
});

test('a run whose typical cell was not quiet is refused on the cause', async () => {
  // Red against a rule on the consequence, such as a count of low-confidence
  // cells. `machineLoad.quiet` is an observation the runner took while it
  // measured; a cut-off on anything downstream of it is a number somebody
  // invented.
  const { refusals } = await verify(
    fixtureBench({
      document: (d) => {
        const copy = structuredClone(d);
        for (const cell of copy.cells) {
          if (cell.outcome === 'ok') cell.machineLoad = { quiet: false, loadAvg1m: 7.77 };
        }
        return copy;
      },
    }),
  );
  assert.ok(refusals.some((r) => /machineLoad\.quiet: false/.test(r)), refusals.join('\n'));
});

test('a debug build is refused', async () => {
  const { refusals } = await verify(
    fixtureBench({
      document: (d) => {
        const copy = structuredClone(d);
        copy.provenance.node.buildProfile = 'debug';
        copy.provenance.node.debugAssertions = true;
        return copy;
      },
      entry: (e) => ({ ...e, host: { ...e.host, buildProfile: 'debug' } }),
    }),
  );
  assert.ok(refusals.some((r) => /was not built for measurement/.test(r)), refusals.join('\n'));
});

test('a profile the pinned config does not publish is refused', async () => {
  const { refusals } = await verify(
    fixtureBench({
      document: (d) => ({ ...structuredClone(d), profile: 'ci' }),
      entry: (e) => ({ ...e, profile: 'ci' }),
    }),
  );
  assert.ok(refusals.some((r) => /is not publishable/.test(r)), refusals.join('\n'));
});

test('an empty allowed set is a configuration fault, never a verdict on a run', async () => {
  // Red against `profile "full" is not publishable ()`. libviprs-bench #82 was
  // ten keys the importer read and the config never defined, and every one of
  // them looked exactly like the gate doing its job. The fault has to be
  // reported on its own, because none of the verdicts underneath would be about
  // the runs.
  const { refusals, configFaults } = await verify(
    fixtureBench({
      config: (c) => ({ ...c, producer: { ...c.producer, publishableProfiles: [] } }),
    }),
  );
  assert.equal(configFaults.length, 1, configFaults.join('\n'));
  assert.match(configFaults[0], /publishableProfiles/);
  assert.ok(!refusals.some((r) => /is not publishable \(\)/.test(r)), 'no empty enumeration is printed');
});

test('an empty history is refused rather than published as a blank page', async () => {
  // Red against a loop over zero entries reporting success. That is the same
  // green as a page full of verified runs and means the opposite.
  const { refusals } = await verify(fixtureBench({ history: () => [] }));
  assert.ok(refusals.some((r) => /carries no runs at all/.test(r)), refusals.join('\n'));
});

test('the pin has to be a full commit sha', async () => {
  // Red against accepting a branch name. A pin that can move is not a pin, and
  // "which benchmark revision is this page showing" stops being answerable from
  // this repository.
  const dir = mkdtempSync(join(tmpdir(), 'pin-'));
  writeFileSync(join(dir, 'BENCH_REV'), 'main\n');
  assert.throws(() => readPin(join(dir, 'BENCH_REV')), /not a full 40-character commit sha/);
});

test('a dirty benchmark checkout cannot put anything on the page', async () => {
  // Red against reading the working tree. This writes a different history into
  // the fixture's working tree after the commit; the read must still return
  // what the pinned object holds.
  const fixture = fixtureBench();
  writeFileSync(join(fixture.dir, BENCH.history), JSON.stringify([{ runId: 'from-the-working-tree' }]));
  const { refusals } = await verify(fixture);
  assert.deepEqual(refusals, []);
});

// ---------------------------------------------------------------------------
// the command, end to end, against the real pinned revision and the real page
// ---------------------------------------------------------------------------

function runIngest(args, cwd = join(here, '..', '..')) {
  return execFileSync(process.execPath, [INGEST, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('--check passes on the repository as it stands', () => {
  // The frozen copy is the pinned history and the page matches it. Everything
  // below mutates a copy; this is the one that reads what is committed.
  const out = runIngest(['--bench', BENCH_DIR, '--check']);
  assert.match(out, /the history is the pinned one and the page matches it/);
});

test('--check fails when the frozen history is not the pinned one', () => {
  // Red against a --check that only re-renders. A history edited here and not
  // over there is the exact state this whole change exists to make impossible.
  const dir = mkdtempSync(join(tmpdir(), 'org-'));
  const history = join(dir, 'history.json');
  const page = join(dir, 'index.html');
  cpSync(HISTORY_PATH, history);
  cpSync(join(here, '..', 'index.html'), page);
  const edited = JSON.parse(readFileSync(history, 'utf8'));
  edited.push({ ...edited[0], runId: 'invented-by-hand' });
  writeFileSync(history, JSON.stringify(edited));
  assert.throws(
    () => runIngest(['--bench', BENCH_DIR, '--check', '--history', history, '--page', page]),
    (e) => /is not the pinned revision/.test(String(e.stderr)),
  );
});

test('--sync regenerates the page from the pinned history', () => {
  // The acceptance in one test: nobody edits HTML, and nobody has to remember
  // to run the renderer afterwards, because the sync does both and then checks
  // itself.
  const dir = mkdtempSync(join(tmpdir(), 'org-'));
  const history = join(dir, 'history.json');
  const page = join(dir, 'index.html');
  writeFileSync(history, '[]\n');
  cpSync(join(here, '..', 'index.html'), page);
  // A hand edit inside a generated region, which is the failure the staleness
  // gate exists for, and an empty history, which is the failure this sync
  // exists for. Both have to be gone afterwards.
  writeFileSync(page, readFileSync(page, 'utf8').replace('22127', '22128'));
  runIngest(['--bench', BENCH_DIR, '--sync', '--history', history, '--page', page]);
  assert.equal(readFileSync(history, 'utf8'), readAtRev(BENCH_DIR, PINNED, BENCH.history));
  assert.ok(
    !readFileSync(page, 'utf8').includes('22128'),
    'the hand edit is gone, because the page was regenerated rather than left alone',
  );
  // And the sync left the two in a state --check agrees with, which is the
  // half that means nobody has to remember to run the renderer.
  const out = runIngest(['--bench', BENCH_DIR, '--check', '--history', history, '--page', page]);
  assert.match(out, /the history is the pinned one and the page matches it/);
});

test('--rev without --sync is a usage error rather than a silent no-op', () => {
  assert.throws(() => runIngest(['--bench', BENCH_DIR, '--rev', PINNED]));
});

test('an unknown flag is a usage error', () => {
  // Red against the shape where `--sink` is read as neither --sync nor an
  // error, so a typo publishes nothing and reports success.
  assert.throws(() => runIngest(['--bench', BENCH_DIR, '--sink']));
});
