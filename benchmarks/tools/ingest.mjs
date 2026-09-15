#!/usr/bin/env node
/* benchmarks/tools/ingest.mjs
 *
 * Read the benchmark history out of libviprs-bench at a pinned revision, prove
 * every entry in it is backed by an archived document at that revision, and
 * regenerate /benchmarks/index.html from it.
 *
 *   node benchmarks/tools/ingest.mjs --bench <libviprs-bench checkout> [--check]
 *   node benchmarks/tools/ingest.mjs --bench <dir> --sync [--rev <sha>]
 *
 * ## Where the numbers live, and why not here
 *
 * The archived documents and the history are artefacts of the benchmark
 * repository. `tools/capture.py` there captures on the measurement host,
 * archives the document by digest, imports it into `tools/publish/history.json`
 * and commits both. This site is a consumer of that, exactly the way
 * `cli/rust/` is a frozen copy of libviprs-cli at `COUNTERPART_REV`.
 *
 * It was not that before, and the gap was not theoretical: the two entries the
 * page drew named run ids that no document in `libviprs-bench/archive/`
 * carried. Every other part of this project holds the opposite line, and
 * `archive/storage/README.md` opens with it, so the page was the one place a
 * number could exist with nothing behind it.
 *
 * ## A pin, and what it costs
 *
 * `benchmarks/BENCH_REV` names one libviprs-bench commit. The alternative was
 * following that repository's `main`, which would mean a capture publishes
 * itself with no commit here. That is the nicer automation and the wrong trade
 * for this project: the discipline everywhere else is that a published number
 * is tied to something you can go and check, and "which benchmark revision is
 * this page showing" has to be answerable from this repository alone, from a
 * file, without asking another repository what its `main` was on the day.
 *
 * The cost is real and is the cost: a capture does not reach the site until
 * somebody bumps the pin. `benchmark-release.yml` is that somebody, and takes
 * the revision as an input.
 *
 * ## What --check actually checks
 *
 * Not that the copy matches. Matching a copy proves the copy is a copy, and a
 * history somebody edited in both places would pass it. So the origin is
 * checked instead:
 *
 *   * every entry joins an archived document at the pinned revision by run id;
 *   * that document's four digests are RECOMPUTED, with the pinned revision's
 *     own canonicaliser, and must equal both the entry's `integrity` block and
 *     the archive index's row;
 *   * the facts the entry restates must equal the document's: profile, commit,
 *     harness commit, emulation verdict, build profile, architecture;
 *   * the document must still pass the rules that let it be published at all,
 *     read from the pinned revision's importer config rather than restated
 *     here: not emulated, release build, no debug assertions, clean tree,
 *     publishable profile, and a run whose typical cell was quiet.
 *
 * A document is read out of git by object, `git show <rev>:<path>`, not out of
 * the checkout's working tree. A dirty checkout of the benchmark repository
 * cannot put anything on this page.
 *
 * ## Why the sync regenerates the page itself
 *
 * Because otherwise somebody has to remember to. `--sync` writes the frozen
 * history and then runs `render-latest.mjs`, in one command, and refuses before
 * it writes anything rather than half way through. `render-latest.mjs --check`
 * still gates staleness on top of that, so the two cannot drift even if
 * somebody edits the page by hand afterwards.
 *
 * Exit codes: 0 fine · 1 refused · 2 usage.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const EXIT = { OK: 0, REFUSED: 1, USAGE: 2 };

/** Where the pin, the frozen history and the page live, relative to this file. */
export const PIN_PATH = join(here, '..', 'BENCH_REV');
export const HISTORY_PATH = join(here, '..', 'history.json');
export const RENDERER = join(here, 'render-latest.mjs');

/** The files this reads out of the benchmark repository, by name in one place.
 *
 *  Named here rather than spelled inline at each use, because the four separate
 *  cross-repository shape mismatches this wave shipped were all the same
 *  failure: two sides of one contract, each correct on its own. A path that
 *  moves over there should break in one place here, loudly.
 */
export const BENCH = {
  history: 'tools/publish/history.json',
  canonicaliser: 'tools/publish/canonical-json.mjs',
  config: 'tools/contract/config.json',
  archiveIndex: (family) => `archive/${family}/index.json`,
  archiveFile: (family, file) => `archive/${family}/${file}`,
};

// ---------------------------------------------------------------------------
// reading the benchmark repository at one revision
// ---------------------------------------------------------------------------

/** One file, out of git, at one revision.
 *
 *  `git show <rev>:<path>` and not the working tree. A checkout can be dirty, on
 *  another branch, or mid-rebase, and none of those may decide what this site
 *  publishes. It also means the pin is checked by construction: a revision the
 *  clone does not carry cannot be read, and the error says so.
 */
export function readAtRev(benchDir, rev, path) {
  try {
    return execFileSync('git', ['-C', benchDir, 'show', `${rev}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(
      `${path} could not be read from libviprs-bench at ${rev}: ${String(e.stderr || e.message).trim()}`,
    );
  }
}

/** The pinned revision's own canonicaliser, imported rather than copied.
 *
 *  The digests are the whole claim, so the code that computes them has to be the
 *  code the producer's importer used. A frozen copy of it here would be a fifth
 *  thing to keep in step, and the first time it drifted every document on the
 *  page would fail to verify for a reason that had nothing to do with the runs.
 */
export async function canonicaliserAt(benchDir, rev) {
  const source = readAtRev(benchDir, rev, BENCH.canonicaliser);
  const dir = mkdtempSync(join(tmpdir(), 'libviprs-ingest-'));
  const file = join(dir, 'canonical-json.mjs');
  writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

/** Follow a dotted path into an object. */
const at = (root, path) => path.split('.').reduce((n, k) => (n == null ? undefined : n[k]), root);

// ---------------------------------------------------------------------------
// the verification
// ---------------------------------------------------------------------------

/** An allowed set that is empty is a fault in the pinned config, never a verdict.
 *
 *  libviprs-bench #82 was ten config keys the importer read and the config never
 *  defined; each one fell back to a default that refused, so the failure looked
 *  exactly like the gate working, and the only tell was an enumeration with
 *  nothing in it. The same shape reaches across the repository boundary here, so
 *  it gets the same treatment: the fault is reported on its own and the document
 *  verdicts underneath are not printed, because none of them would be about the
 *  runs.
 */
function ruleSet(producer, key, faults, consequence) {
  const values = [...(producer?.[key] ?? [])];
  if (values.length === 0) {
    faults.push(
      `the pinned libviprs-bench config defines producer.${key} as ` +
        `${JSON.stringify(producer?.[key])}, so ${consequence}. Nothing about the history ` +
        'reached this: with nothing in that set no value could have passed.',
    );
  }
  return values;
}

/** Verify that every entry in the pinned history is backed by an archived,
 *  digest-verified, publishable document at the same revision.
 *
 *  Returns `{ refusals, configFaults, checked }`. Every reason, never the first:
 *  a page that is going to need three captures should say so once.
 */
export async function verifyOrigin({ benchDir, rev }) {
  const refusals = [];
  const configFaults = [];
  const historyText = readAtRev(benchDir, rev, BENCH.history);
  const history = JSON.parse(historyText);
  if (!Array.isArray(history)) {
    return { refusals: [`${BENCH.history} at ${rev} is not a JSON array`], configFaults, history: [], historyText };
  }

  const producer = JSON.parse(readAtRev(benchDir, rev, BENCH.config)).producer ?? {};
  const publishable = ruleSet(
    producer,
    'publishableProfiles',
    configFaults,
    'no profile is publishable and every run on the page is refused by a rule that was never ' +
      'written down',
  );
  const families = ruleSet(
    producer,
    'families',
    configFaults,
    'every entry names a family this config does not know, and the refusal reads as a producer ' +
      'that invented one',
  );
  const familyPrefix = producer.familyIdPrefix ?? '';
  const { computeDigests, CanonicalError } = await canonicaliserAt(benchDir, rev);

  // One index read per family, not per entry.
  const indexes = new Map();
  const indexFor = (family) => {
    if (!indexes.has(family)) {
      try {
        indexes.set(family, JSON.parse(readAtRev(benchDir, rev, BENCH.archiveIndex(family))));
      } catch (e) {
        indexes.set(family, { error: e.message });
      }
    }
    return indexes.get(family);
  };

  // An empty history is not a pass. The page draws nothing from it, `--check`
  // has nothing to compare and every loop below runs zero times, which is the
  // exact shape that ships green while proving nothing.
  if (history.length === 0) {
    refusals.push(
      `the pinned history at ${rev} carries no runs at all, so this would publish a page with ` +
        'no measurement on it. An empty reading is a refusal and not a result.',
    );
  }

  for (const entry of history) {
    const where = `${entry.family ?? 'unknown'} ${entry.runId ?? '(no run id)'}`;
    const documentFamily = entry.familyName ?? `${familyPrefix}${entry.family}`;
    if (families.length > 0 && !families.includes(documentFamily)) {
      refusals.push(
        `${where}: the entry names family ${JSON.stringify(documentFamily)}, which the pinned ` +
          `config does not know (${families.join(', ')})`,
      );
      continue;
    }
    if (!entry.runId) {
      refusals.push(`${where}: the entry carries no run id, so nothing can be joined to it`);
      continue;
    }
    const index = indexFor(entry.family);
    if (!Array.isArray(index)) {
      refusals.push(
        `${where}: archive/${entry.family}/index.json could not be read at ${rev} ` +
          `(${index?.error ?? 'not an array'}), so this run is not citable`,
      );
      continue;
    }
    const row = index.find((r) => r?.runId === entry.runId);
    if (!row) {
      refusals.push(
        `${where}: no archived document at ${rev} carries this run id. The archive index holds ` +
          `${index.length} run(s) and none of them is this one, so the page would draw a number ` +
          'that no artefact supports.',
      );
      continue;
    }

    let document;
    try {
      document = JSON.parse(readAtRev(benchDir, rev, BENCH.archiveFile(entry.family, row.file)));
    } catch (e) {
      refusals.push(`${where}: ${e.message}`);
      continue;
    }

    // The digests, recomputed. The index row alone catches a swapped file and
    // not an edited one, because an edited document carries whatever digests the
    // editor left in it and the row was written before the edit.
    let digests;
    try {
      digests = computeDigests(document);
    } catch (e) {
      refusals.push(
        `${where}: the archived document cannot be canonicalised, so its digests cannot be ` +
          `checked: ${e instanceof CanonicalError ? e.message : String(e)}`,
      );
      continue;
    }
    const moved = ['cells', 'runners', 'measurements', 'document'].filter(
      (block) => (entry.integrity ?? {})[block] !== digests[block],
    );
    if (moved.length > 0) {
      refusals.push(
        `${where}: the history entry's digests do not match the archived document: ` +
          moved
            .map((b) => `${b} states ${entry.integrity?.[b] ?? 'nothing'} and digests ${digests[b]}`)
            .join('; '),
      );
    }
    if (row.documentDigest !== digests.document) {
      refusals.push(
        `${where}: the archive index records documentDigest ${row.documentDigest} and the ` +
          `document digests to ${digests.document}; one of the two has been edited since the ` +
          'run was filed',
      );
    }

    // The facts the entry restates. An entry is derived from a document, so a
    // disagreement means one of the two was written by hand, and a page that
    // labels a debug run `release` is worse than a page with nothing on it.
    for (const [field, entryValue, documentPath] of [
      ['profile', entry.profile, 'profile'],
      ['commit', entry.commit, 'provenance.library.commit'],
      ['harnessCommit', entry.harnessCommit, 'provenance.commit'],
      ['emulated', entry.emulated, 'provenance.emulated'],
      ['host.arch', entry.host?.arch, 'provenance.arch'],
      ['host.buildProfile', entry.host?.buildProfile, 'provenance.node.buildProfile'],
      ['startedAt', entry.startedAt, 'startedAt'],
    ]) {
      const documentValue = at(document, documentPath);
      if (JSON.stringify(entryValue) !== JSON.stringify(documentValue)) {
        refusals.push(
          `${where}: the entry says ${field} is ${JSON.stringify(entryValue)} and the archived ` +
            `document's ${documentPath} is ${JSON.stringify(documentValue)}`,
        );
      }
    }

    // The rules that decide whether the run may be published at all, applied to
    // the document rather than to the entry's account of it.
    const prov = document.provenance ?? {};
    const node = prov.node ?? {};
    if (prov.emulated !== false) {
      refusals.push(
        `${where}: provenance.emulated is ${prov.emulated === undefined ? 'absent' : JSON.stringify(prov.emulated)} ` +
          'and only an observed `false` may be published; an unobserved run is not a native one',
      );
    } else if (!Array.isArray(prov.emulationEvidence) || prov.emulationEvidence.length === 0) {
      refusals.push(`${where}: emulated is false with no emulationEvidence, which is an assertion rather than an observation`);
    }
    if (publishable.length > 0 && !publishable.includes(document.profile)) {
      refusals.push(
        `${where}: profile ${JSON.stringify(document.profile ?? null)} is not publishable ` +
          `(${publishable.join(', ')})`,
      );
    }
    if (node.debugAssertions !== false || node.buildProfile !== 'release') {
      refusals.push(
        `${where}: the document was not built for measurement (buildProfile ` +
          `${JSON.stringify(node.buildProfile ?? null)}, debugAssertions ` +
          `${JSON.stringify(node.debugAssertions ?? null)})`,
      );
    }
    for (const [label, value] of [
      ['provenance.dirty', prov.dirty],
      ['provenance.library.dirty', prov.library?.dirty],
    ]) {
      if (value !== false) {
        refusals.push(
          `${where}: ${label} is ${value === undefined ? 'absent' : JSON.stringify(value)}; a ` +
            'missing flag is not a clean tree',
        );
      }
    }
    // On the cause and not the consequence. `machineLoad.quiet` is what the
    // runner observed while it measured the cell; a count of low-confidence
    // cells is downstream of it, and picking a cut-off there means inventing a
    // number.
    const cells = Array.isArray(document.cells) ? document.cells : [];
    const withLoad = cells.filter(
      (c) => c.outcome === 'ok' && typeof c.machineLoad?.quiet === 'boolean',
    );
    const noisy = withLoad.filter((c) => c.machineLoad.quiet === false);
    if (withLoad.length > 0 && noisy.length > withLoad.length / 2) {
      refusals.push(
        `${where}: ${noisy.length} of ${withLoad.length} measured cells record ` +
          '`machineLoad.quiet: false`, so the typical cell of this run was measured while other ' +
          'work was on the CPU',
      );
    }
    if (cells.filter((c) => c.outcome === 'ok').length === 0) {
      refusals.push(`${where}: the archived document has no \`ok\` cell; an empty reading is a refusal`);
    }
  }

  return { refusals, configFaults, history, historyText };
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

function render(pagePath, historyPath, check) {
  const args = [RENDERER, '--history', historyPath, '--page', pagePath];
  if (check) args.push('--check');
  execFileSync(process.execPath, args, { stdio: 'inherit' });
}

export function readPin(pinPath = PIN_PATH) {
  if (!existsSync(pinPath)) {
    throw new Error(`no pin at ${pinPath}; this site reads its history from a named libviprs-bench revision`);
  }
  const rev = readFileSync(pinPath, 'utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(rev)) {
    throw new Error(
      `${pinPath} holds ${JSON.stringify(rev)}, which is not a full 40-character commit sha. ` +
        'A short sha or a branch name is a pin that can move, which is the thing a pin is for.',
    );
  }
  return rev;
}

async function main(argv) {
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const has = (n) => argv.includes(`--${n}`);
  const KNOWN = new Set(['bench', 'rev', 'check', 'sync', 'history', 'page', 'pin', 'help']);
  const unknown = argv
    .filter((a) => a.startsWith('--'))
    .map((a) => a.slice(2).split('=')[0])
    .filter((a) => !KNOWN.has(a));
  if (unknown.length > 0) {
    console.error(`unknown flag(s): ${unknown.map((u) => `--${u}`).join(', ')}`);
    return EXIT.USAGE;
  }
  if (has('help') || !flag('bench')) {
    console.error(
      'usage: node benchmarks/tools/ingest.mjs --bench <libviprs-bench checkout> [--check]\n' +
        '       node benchmarks/tools/ingest.mjs --bench <dir> --sync [--rev <sha>]',
    );
    return EXIT.USAGE;
  }

  const benchDir = resolve(flag('bench'));
  const pinPath = resolve(flag('pin') ?? PIN_PATH);
  const historyPath = resolve(flag('history') ?? HISTORY_PATH);
  const pagePath = resolve(flag('page') ?? join(here, '..', 'index.html'));
  const sync = has('sync');
  const rev = flag('rev') ?? readPin(pinPath);
  if (flag('rev') && !sync) {
    console.error('--rev moves the pin, so it only makes sense with --sync');
    return EXIT.USAGE;
  }

  console.log(`libviprs-bench ${rev}`);
  const { refusals, configFaults, historyText } = await verifyOrigin({ benchDir, rev });

  if (configFaults.length > 0) {
    console.error(
      `REFUSED, and not because of these runs: the pinned libviprs-bench config does not define ` +
        `${configFaults.length === 1 ? 'a rule' : 'rules'} this reads.\n`,
    );
    for (const f of configFaults) console.error(`  · ${f}\n`);
    return EXIT.REFUSED;
  }
  if (refusals.length > 0) {
    console.error('REFUSED. This history may not be published:\n');
    for (const r of refusals) console.error(`  · ${r}\n`);
    console.error(
      sync
        ? 'Nothing was written, so the page is unchanged and says nothing new.\n'
        : 'The page is unchanged.\n',
    );
    return EXIT.REFUSED;
  }

  if (!sync) {
    // The frozen copy is checked LAST and only once the origin holds, so a
    // mismatch here reads as "the copy is stale" rather than being the first
    // thing a reader sees when the real problem is upstream.
    const frozen = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : null;
    if (frozen !== historyText) {
      console.error(
        `REFUSED: ${historyPath} is not the pinned revision's tools/publish/history.json.\n\n` +
          '  · Run this with --sync to take the pinned history and regenerate the page from it.\n',
      );
      return EXIT.REFUSED;
    }
    render(pagePath, historyPath, true);
    console.log('the history is the pinned one and the page matches it');
    return EXIT.OK;
  }

  writeFileSync(historyPath, historyText);
  if (flag('rev')) writeFileSync(pinPath, `${rev}\n`);
  // The page follows in the same command, because otherwise somebody has to
  // remember to run the renderer and the one time they do not the page is a
  // published figure no run supports.
  render(pagePath, historyPath, false);
  render(pagePath, historyPath, true);
  console.log(`synced ${historyPath} and regenerated ${pagePath} from libviprs-bench ${rev}`);
  return EXIT.OK;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`refused: ${e.message}`);
      process.exit(EXIT.REFUSED);
    },
  );
}
