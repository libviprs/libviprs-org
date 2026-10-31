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
 *   * the document must still pass the rules that let it be published at all:
 *     not emulated, release build with assertions off, a clean tree on both
 *     sides, a publishable profile, at least one measured cell, and a run whose
 *     typical cell was quiet. Two of those come out of the pinned revision's own
 *     importer config, the profiles and the families, because the producer keeps
 *     them there. The rest are written out in this file, because over there they
 *     are code rather than config. That is a second copy and it can drift, and
 *     saying so is better than a sentence claiming all of it is read.
 *
 * The entries it puts through that are the FROZEN COPY's, because that is the
 * file the page is generated from, and the byte comparison with the pinned
 * original comes after. Equality plus a verified original does imply a verified
 * copy, so checking the original alone is sound as logic; it is wrong as a
 * message, and the first version of this file proved it. Its own CI mutation
 * adds a run no archived document supports to the copy, and it went red saying
 * "this copy is not the pinned revision's history", which is true, about
 * something else, and sends the reader to the wrong file.
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

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const EXIT = { OK: 0, REFUSED: 1, USAGE: 2 };

/** Where the pin, the frozen history and the page live, relative to this file. */
export const PIN_PATH = join(here, '..', 'BENCH_REV');
export const HISTORY_PATH = join(here, '..', 'history.json');
export const RENDERER = join(here, 'render-latest.mjs');
/** Where the rendered chart files and their manifest live, next to the page. */
export const CHARTS_DIR = join(here, '..', 'charts');
export const CHARTS_MANIFEST = 'manifest.json';

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
export async function verifyOrigin({ benchDir, rev, history: given }) {
  const refusals = [];
  const configFaults = [];
  const historyText = readAtRev(benchDir, rev, BENCH.history);
  // The entries to verify default to the pinned revision's own history, and
  // `--check` hands in the FROZEN COPY instead. Verifying the copy is not
  // redundant with comparing it: equality plus a verified original does imply a
  // verified copy, but a refusal that reads "the copy differs" when the real
  // problem is a run no document supports sends the reader to the wrong file.
  // The first version of this checked the original only, and its own CI
  // mutation, which adds an unbacked run to the copy, went red on the byte
  // comparison while claiming to prove something else.
  let history;
  try {
    history = given ?? JSON.parse(historyText);
  } catch (e) {
    return { refusals: [`the history handed to this check is not JSON (${e.message})`], configFaults, history: [], historyText };
  }
  if (!Array.isArray(history)) {
    return { refusals: [`the history is not a JSON array`], configFaults, history: [], historyText };
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
    // On the cause and not the consequence, and the cause moved (libviprs-bench
    // #100). Counting cells that recorded `machineLoad.quiet: false` was
    // measuring the sweep as much as the machine: a one-minute load average has
    // a one-minute memory and a sweep spends every second of it working, so the
    // busier the family the louder it reads. Back to back on one six-core box,
    // `engines` flagged 108 of 558 cells and `storage` flagged 0 of 539, and the
    // difference is how many threads each family asks for.
    //
    // `startingLoad` is sampled by the runner before it measures anything, so
    // none of that load is ours. Same line as before, one runnable thread per
    // core; it just moved to a reading where it means what it says.
    //
    // Both rules live here because the archive keeps documents forever and this
    // file re-verifies the whole published history on every ingest. A document
    // with no `startingLoad` predates the field and keeps the rule it was
    // published under. `in` rather than `?? null`: serde writes an unfilled
    // block as an explicit null, so a key that is present and null is a runner
    // that skipped its own first act, which is a refusal rather than a document
    // from 2026-09-14.
    const cells = Array.isArray(document.cells) ? document.cells : [];
    if (!Object.hasOwn(document, 'startingLoad')) {
      const withLoad = cells.filter(
        (c) => c.outcome === 'ok' && typeof c.machineLoad?.quiet === 'boolean',
      );
      const noisy = withLoad.filter((c) => c.machineLoad.quiet === false);
      if (withLoad.length > 0 && noisy.length > withLoad.length / 2) {
        refusals.push(
          `${where}: ${noisy.length} of ${withLoad.length} measured cells record ` +
            '`machineLoad.quiet: false`, so the typical cell of this run was measured while ' +
            'other work was on the CPU. This document carries no `startingLoad`, so it ' +
            'predates the rule that reads one',
        );
      }
    } else {
      const starting = document.startingLoad;
      const contention = starting?.contentionPerCore;
      if (starting === null || typeof starting !== 'object') {
        refusals.push(
          `${where}: \`startingLoad\` is ${JSON.stringify(starting ?? null)}, which is a runner ` +
            'that knows about the field and left it unfilled, not a run that predates it',
        );
      } else if (!Number.isFinite(contention)) {
        refusals.push(
          `${where}: \`startingLoad.contentionPerCore\` is ` +
            `${JSON.stringify(contention ?? null)}, so the machine was looked at and could not ` +
            'be read; an empty reading is a refusal',
        );
      } else if (starting.quiet !== contention < 1) {
        refusals.push(
          `${where}: \`startingLoad\` says \`quiet: ${JSON.stringify(starting.quiet)}\` and ` +
            `carries \`contentionPerCore: ${contention}\`, which do not agree`,
        );
      } else if (contention >= 1) {
        refusals.push(
          `${where}: \`startingLoad\` records ${starting.loadAvg1m} on ${starting.cores} ` +
            `core(s), ${contention.toFixed(2)} runnable per core, before this sweep started; ` +
            'none of that load is the sweep\'s own',
        );
      }
    }
    if (cells.filter((c) => c.outcome === 'ok').length === 0) {
      refusals.push(`${where}: the archived document has no \`ok\` cell; an empty reading is a refusal`);
    }
  }

  return { refusals, configFaults, history, historyText };
}

// ---------------------------------------------------------------------------
// the charts (libviprs-org#91)
// ---------------------------------------------------------------------------
//
// causl-org serves file-based charts, `<img src="charts/chart_x.svg">`, drawn by
// its benchmark repository's renderer. This does the same, with one difference
// that matters: the SVGs are not committed over there (`report/**/*.svg` is
// gitignored in libviprs-bench), so there is nothing to copy. They are DRAWN
// here, at ingest, by the pinned revision's own renderer, from the archived
// document the page already verifies. That keeps the property this directory
// exists for: a chart cannot drift from the numbers printed beside it, because
// both come out of the same document at the same revision.
//
// What the pinned revision can draw is what appears. `render.mjs` there reads
// the Rust harness's JSON (benchmark_history.json, benchmark_results.json),
// which the archived Python-runner documents are not, so it has nothing to draw
// from them. `storage-charts.mjs` reads the archived storage document, so that
// is the renderer used. The engines family has no renderer over there yet; its
// charts on the page stay the ones render-latest.mjs draws, and the manifest
// says which family the files are for rather than implying more.

/** What the pinned revision's renderer needs, read out of git by object. */
export const CHARTS_RENDERER = 'tools/charts/storage-charts.mjs';
const CHARTS_FAMILY = 'storage';

/** One install per revision per process. `npm ci` is the slow, networked step. */
const installed = new Map();

/** The pinned revision's chart code and its locked dependencies, in a temp dir.
 *
 *  `git archive` and not the working tree, for the same reason readAtRev is
 *  `git show`: a dirty checkout of the benchmark repository cannot put anything
 *  on the page. The renderer's one dependency (`@spdrman/bencharts`) comes from
 *  the revision's own lockfile via `npm ci`, so it is the version the producer
 *  drew with and not whatever is newest.
 */
export function chartCodeAt(benchDir, rev) {
  if (installed.has(`${benchDir}\0${rev}`)) return installed.get(`${benchDir}\0${rev}`);
  try {
    execFileSync('git', ['-C', benchDir, 'cat-file', '-e', `${rev}:${CHARTS_RENDERER}`], { stdio: 'ignore' });
  } catch {
    throw new Error(
      `libviprs-bench at ${rev} has no ${CHARTS_RENDERER}, so it cannot draw the ${CHARTS_FAMILY} ` +
        'family and there is nothing to put in benchmarks/charts/. Pin a revision that has it.',
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'libviprs-charts-'));
  const archive = spawnSync(
    'git',
    ['-C', benchDir, 'archive', '--format=tar', rev, 'tools/charts', 'package.json', 'package-lock.json'],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  if (archive.status !== 0) {
    throw new Error(`could not archive the chart code at ${rev}: ${String(archive.stderr).trim()}`);
  }
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`could not unpack the chart code: ${String(untar.stderr).trim()}`);
  const npm = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (npm.status !== 0) {
    throw new Error(`npm ci failed for the chart code at ${rev}: ${(npm.stderr || npm.stdout).trim()}`);
  }
  installed.set(`${benchDir}\0${rev}`, dir);
  return dir;
}

/** The first <text> in a chart is its title. */
function titleOf(svg) {
  const m = /<text[^>]*>([^<]*)<\/text>/.exec(svg);
  return (m ? m[1] : '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** The charts come from the latest SWEEP of the family: a run that reports one of the family's
 *  headline keys. The PVec row (libviprs-bench#143) and the writer sweeps are storage-family
 *  documents too, and neither reports one, so neither is drawn here. The page shows the PVec row as
 *  its own table. */
const PAGE_CONFIG = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
const isSweepEntry = (e) => (PAGE_CONFIG.families[e.family]?.headlineKeys ?? [])
  .some((k) => (e.samples ?? []).some((s) => s.key === k));

/** The latest run of the charted family, by capture time. */
export function latestRun(history, family = CHARTS_FAMILY) {
  return history
    .filter((e) => e.family === family && isSweepEntry(e))
    .sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)))
    .at(-1);
}

/** Draw the charts for a history at a pinned revision.
 *
 *  Returns `{ files, manifestText }`: file name to SVG text, and the manifest
 *  that render-latest.mjs turns into the page section. Pure with respect to this
 *  repository: nothing is written.
 */
export async function renderChartsAt({ benchDir, rev, history }) {
  const run = latestRun(history);
  if (!run) throw new Error(`the history carries no ${CHARTS_FAMILY} run, so there is nothing to draw`);
  const index = JSON.parse(readAtRev(benchDir, rev, BENCH.archiveIndex(run.family)));
  const row = index.find((r) => r?.runId === run.runId);
  if (!row) throw new Error(`run ${run.runId} is not in archive/${run.family}/index.json at ${rev}`);
  const document = JSON.parse(readAtRev(benchDir, rev, BENCH.archiveFile(run.family, row.file)));

  const dir = chartCodeAt(benchDir, rev);
  const { buildStorageCharts } = await import(pathToFileURL(join(dir, CHARTS_RENDERER)).href);
  const { charts, held, violations } = buildStorageCharts(document);
  if (violations.length > 0) {
    throw new Error(
      `the pinned comparability contract is violated by run ${run.runId}: ` +
        violations.map((v) => v.rule ?? JSON.stringify(v)).slice(0, 5).join('; '),
    );
  }
  if (charts.length === 0) {
    throw new Error(`the pinned renderer drew no charts from run ${run.runId}; an empty reading is a refusal`);
  }

  const files = new Map();
  for (const c of [...charts].sort((a, b) => a.filename.localeCompare(b.filename))) files.set(c.filename, c.svg);
  const manifest = {
    renderer: `libviprs-bench ${CHARTS_RENDERER}`,
    rev,
    family: run.family,
    runId: run.runId,
    charts: [...files].map(([file, svg]) => {
      const c = charts.find((x) => x.filename === file);
      return { file, scenario: c.scenario, metric: c.metric, title: titleOf(svg) };
    }),
    held: held
      .map((h) => ({ scenario: h.scenario, metric: h.metric ?? null, status: h.status }))
      .sort((a, b) => `${a.scenario}${a.metric}${a.status}`.localeCompare(`${b.scenario}${b.metric}${b.status}`))
      .filter((h, i, all) => i === 0 || JSON.stringify(h) !== JSON.stringify(all[i - 1])),
  };
  return { files, manifestText: `${JSON.stringify(manifest, null, 2)}\n` };
}

/** Compare a rendering with what is on disk. Every difference, never the first. */
export function diffCharts(chartsDir, { files, manifestText }) {
  const problems = [];
  const onDisk = existsSync(chartsDir)
    ? readdirSync(chartsDir).filter((f) => f.endsWith('.svg')).sort()
    : [];
  for (const [name, svg] of files) {
    const path = join(chartsDir, name);
    if (!existsSync(path)) {
      problems.push(`charts/${name} is missing; the pinned renderer draws it`);
    } else if (readFileSync(path, 'utf8') !== svg) {
      problems.push(`charts/${name} differs from what the pinned renderer draws from the pinned document`);
    }
  }
  for (const name of onDisk) {
    if (!files.has(name)) problems.push(`charts/${name} is not drawn by the pinned renderer, so nothing supports it`);
  }
  const manifestPath = join(chartsDir, CHARTS_MANIFEST);
  if (!existsSync(manifestPath)) problems.push(`charts/${CHARTS_MANIFEST} is missing`);
  else if (readFileSync(manifestPath, 'utf8') !== manifestText) {
    problems.push(`charts/${CHARTS_MANIFEST} differs from what the pinned renderer produced`);
  }
  return problems;
}

/** Replace the chart directory's contents with a rendering. */
export function writeCharts(chartsDir, { files, manifestText }) {
  mkdirSync(chartsDir, { recursive: true });
  for (const name of readdirSync(chartsDir)) {
    if (name.endsWith('.svg') || name === CHARTS_MANIFEST) rmSync(join(chartsDir, name));
  }
  for (const [name, svg] of files) writeFileSync(join(chartsDir, name), svg);
  writeFileSync(join(chartsDir, CHARTS_MANIFEST), manifestText);
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

function render(pagePath, historyPath, check, chartsDir) {
  const args = [RENDERER, '--history', historyPath, '--page', pagePath, '--charts', chartsDir];
  if (check) args.push('--check');
  execFileSync(process.execPath, args, { stdio: 'inherit' });
}

/** A full commit sha, or an error naming what was given instead.
 *
 *  Separate from `readPin` because `--rev` writes a pin without ever reading
 *  one, and the first version validated only on the read. `--sync --rev main`
 *  was accepted and left `BENCH_REV` holding `main`, which the next `--check`
 *  refuses, and for that one run the page was published from a moving ref. That
 *  is the single thing this file's header argues against for forty lines, so the
 *  check belongs at every door and not just the one I happened to write first.
 */
export function assertFullSha(rev, where) {
  if (!/^[0-9a-f]{40}$/.test(rev)) {
    throw new Error(
      `${where} is ${JSON.stringify(rev)}, which is not a full 40-character commit sha. ` +
        'A short sha or a branch name is a pin that can move, which is the thing a pin is for.',
    );
  }
  return rev;
}

export function readPin(pinPath = PIN_PATH) {
  if (!existsSync(pinPath)) {
    throw new Error(`no pin at ${pinPath}; this site reads its history from a named libviprs-bench revision`);
  }
  return assertFullSha(readFileSync(pinPath, 'utf8').trim(), pinPath);
}

async function main(argv) {
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const has = (n) => argv.includes(`--${n}`);
  const KNOWN = new Set(['bench', 'rev', 'check', 'sync', 'history', 'page', 'pin', 'charts', 'help']);
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
        '       node benchmarks/tools/ingest.mjs --bench <dir> --sync [--rev <sha>]\n' +
        '       (--charts <dir> to point the chart directory elsewhere)',
    );
    return EXIT.USAGE;
  }

  const benchDir = resolve(flag('bench'));
  const pinPath = resolve(flag('pin') ?? PIN_PATH);
  const historyPath = resolve(flag('history') ?? HISTORY_PATH);
  const pagePath = resolve(flag('page') ?? join(here, '..', 'index.html'));
  const chartsDir = resolve(flag('charts') ?? CHARTS_DIR);
  const sync = has('sync');
  if (flag('rev') && !sync) {
    console.error('--rev moves the pin, so it only makes sense with --sync');
    return EXIT.USAGE;
  }
  const rev = flag('rev') ? assertFullSha(flag('rev'), '--rev') : readPin(pinPath);

  console.log(`libviprs-bench ${rev}`);
  // On `--check` the entries verified are the ones the page is generated from,
  // which is the frozen copy. On `--sync` they are the pinned revision's,
  // because the copy is about to be replaced by it.
  const frozen = !sync && existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : null;
  let frozenEntries;
  if (!sync) {
    if (frozen === null) {
      console.error(`REFUSED: there is no frozen history at ${historyPath} to check.\n`);
      return EXIT.REFUSED;
    }
    try {
      frozenEntries = JSON.parse(frozen);
    } catch (e) {
      console.error(`REFUSED: ${historyPath} is not JSON (${e.message}).\n`);
      return EXIT.REFUSED;
    }
  }
  const { refusals, configFaults, historyText } = await verifyOrigin({
    benchDir,
    rev,
    history: frozenEntries,
  });

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
    // The byte comparison comes LAST and only once the copy's own entries hold,
    // so "this copy is not the pinned one" is never the sentence a reader gets
    // when the real problem is a run nothing supports.
    if (frozen !== historyText) {
      console.error(
        `REFUSED: ${historyPath} is not the pinned revision's tools/publish/history.json.\n\n` +
          '  · Run this with --sync to take the pinned history and regenerate the page from it.\n',
      );
      return EXIT.REFUSED;
    }
    // Re-render and compare. Not a checksum of what was written last time: a
    // stale SVG next to fresh numbers is a page that contradicts itself and
    // looks fine, so the pinned renderer draws them again and every byte is
    // compared.
    const drawn = await renderChartsAt({ benchDir, rev, history: frozenEntries });
    const stale = diffCharts(chartsDir, drawn);
    if (stale.length > 0) {
      console.error('REFUSED: the charts are not what the pinned renderer draws from the pinned document.\n');
      for (const p of stale) console.error(`  · ${p}\n`);
      console.error('  · Run this with --sync to redraw them.\n');
      return EXIT.REFUSED;
    }
    render(pagePath, historyPath, true, chartsDir);
    console.log(`the history is the pinned one, ${drawn.files.size} chart(s) match the pinned renderer, and the page matches`);
    return EXIT.OK;
  }

  // Draw before anything is written, so a renderer that cannot draw refuses
  // with the tree untouched, the way a history that cannot verify does.
  const drawn = await renderChartsAt({ benchDir, rev, history: JSON.parse(historyText) });
  writeFileSync(historyPath, historyText);
  writeCharts(chartsDir, drawn);
  if (flag('rev')) writeFileSync(pinPath, `${rev}\n`);
  // The page follows in the same command, because otherwise somebody has to
  // remember to run the renderer and the one time they do not the page is a
  // published figure no run supports.
  render(pagePath, historyPath, false, chartsDir);
  render(pagePath, historyPath, true, chartsDir);
  console.log(`synced ${historyPath}, ${drawn.files.size} chart(s) and ${pagePath} from libviprs-bench ${rev}`);
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
