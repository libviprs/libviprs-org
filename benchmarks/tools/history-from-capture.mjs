#!/usr/bin/env node
/* benchmarks/tools/history-from-capture.mjs
 *
 * Turn an archived libviprs-bench document into an entry in history.json, which
 * is what render-latest.mjs reads.
 *
 * THIS IS A STOPGAP. libviprs-bench#77 is the real importer, it lives next to
 * the producer, and it has the whole refusal set. This file exists because the
 * page cannot be built against a history that does not exist yet, and it does
 * the minimum the page's own rule needs: it refuses a document it cannot
 * address by digest, and it refuses to invent provenance a document does not
 * carry. When #77 lands, delete this and regenerate.
 *
 *   node benchmarks/tools/history-from-capture.mjs \
 *     --storage <archived-document.json> \
 *     --engines <raw-export.json> --engines-attestation <attestation.json> \
 *     [--out benchmarks/history.json] [--config benchmarks/tools/config.json]
 *
 * ## The two families do not arrive the same way, and the page says so
 *
 * The storage document is an archived libviprs-bench run: repetitions,
 * dispersion, a provenance block the runner observed on the host, an emulation
 * probe, and four integrity digests. Every one of those becomes a field here.
 *
 * The engines export is the older shape: one measurement per cell, no
 * repetitions, no dispersion, and no provenance block at all. So its provenance
 * is an attestation by whoever ran it, carried in a sidecar, and stamped
 * `provenanceSource: "attested"` so the page can say "somebody vouched for
 * this" rather than dressing it up as something the runner observed. Every one
 * of its samples lands `gated: false`: with one measurement there is nothing a
 * pass or a regression could be read off.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXIT = { OK: 0, USAGE: 2, REFUSED: 3 };

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};

const KNOWN = new Set(['storage', 'archive-index', 'engines', 'engines-attestation', 'out', 'config', 'help']);
const unknown = argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2)).filter((a) => !KNOWN.has(a));
if (unknown.length || argv.includes('--help')) {
  console.error(`usage: node benchmarks/tools/history-from-capture.mjs --storage <doc> [--engines <export> --engines-attestation <json>] [--out <history.json>]`);
  if (unknown.length) console.error(`unknown flag(s): ${unknown.map((u) => `--${u}`).join(', ')}`);
  process.exit(EXIT.USAGE);
}

const outPath = resolve(flag('out') ?? join(here, '..', 'history.json'));
const configPath = resolve(flag('config') ?? join(here, 'config.json'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));

const refuse = (why) => {
  console.error(`refused: ${why}`);
  process.exit(EXIT.REFUSED);
};

const sha256 = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

function storageEntry(docPath) {
  const raw = readFileSync(docPath);
  const doc = JSON.parse(raw.toString('utf8'));

  if (!doc.integrity?.document) refuse(`${docPath} carries no integrity.document digest, so it cannot be addressed`);
  if (!doc.provenance?.commit) refuse(`${docPath} carries no provenance.commit`);
  if (doc.provenance.dirty) refuse(`${docPath} was measured from a dirty tree`);

  const runId = doc.runId ?? runIdFromArchiveIndex(doc) ?? deriveRunId(doc);
  const cellOf = new Map();
  for (const c of doc.cells) cellOf.set(`${c.scale}/${c.source}`, c.cell);

  const tick = doc.measurement?.timerTickNs;
  const floorTicks = doc.measurement?.minTicksPerSample ?? config.confidence.minTicksPerSample;

  // The replicate pair is the same cell measured twice inside one run, and it
  // is what `replicate.spreadPct` is computed from. Both copies stay: dropping
  // one would quietly change the document's own cell counts, which the page
  // quotes. Each carries the index of which copy it is, and the page shows the
  // first and draws the band from the pair.
  const seen = new Map();
  const samples = [];
  const skipped = [];
  let replicated = 0;

  for (const c of doc.cells) {
    const id = `${c.backend}/${c.cell}/${c.key}`;
    const replicateIndex = seen.get(id) ?? 0;
    seen.set(id, replicateIndex + 1);
    if (replicateIndex > 0) replicated++;

    if (c.outcome !== 'ok') {
      skipped.push({
        series: c.backend, cell: c.cell, scale: c.scale, source: c.source,
        scenario: c.scenario, metric: c.metric, key: c.key,
        outcome: c.outcome, reason: c.reason ?? null, replicateIndex,
      });
      continue;
    }

    const reasons = [...(c.lowConfidenceReasons ?? [])];
    const blockers = [];
    if (c.reps < c.minReps) blockers.push(`fewer than the minimum repetitions (${c.reps} of ${c.minReps})`);
    if (c.timerSaturated === true) blockers.push(`the timer saturated: the median is under the ${((tick * floorTicks) / 1000).toFixed(1)} us floor this host's clock supports`);
    if (c.confidence !== 'high') blockers.push('the cell declares itself low confidence');

    samples.push({
      series: c.backend, cell: c.cell, scale: c.scale, source: c.source,
      scenario: c.scenario, metric: c.metric, key: c.key,
      unit: c.unit, direction: c.direction, replicateIndex,
      reps: c.reps, minReps: c.minReps,
      median: c.median, min: c.min, max: c.max,
      p95: c.p95OfSamples ?? null,
      cov: c.cov ?? null,
      ci95: c.ci95 ?? null,
      ciHalfWidthPct: c.ciHalfWidthPct ?? null,
      confidence: c.confidence,
      lowConfidenceReasons: reasons,
      timerSaturated: c.timerSaturated === true,
      quietHost: c.machineLoad?.quiet ?? null,
      gated: blockers.length === 0,
      gateBlockers: blockers,
    });
  }

  const invariants = doc.invariants.map((i) => ({
    series: i.library, library: i.library, scale: i.scale, source: i.source,
    cell: cellOf.get(`${i.scale}/${i.source}`) ?? null,
    name: i.name, value: i.value, unit: i.unit,
  }));

  return {
    runId,
    family: 'storage',
    source: 'libviprs-bench',
    runner: doc.runner,
    profile: doc.profile,
    capturedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
    documentDigest: doc.integrity.document,
    integrity: doc.integrity,
    provenanceSource: 'observed',
    attestation: null,
    importedBy: 'benchmarks/tools/history-from-capture.mjs (stopgap for libviprs-bench#77)',
    library: {
      name: doc.provenance.library?.name ?? 'libviprs',
      version: doc.provenance.library?.version ?? null,
      commit: doc.provenance.library?.commit ?? null,
      mainRelation: doc.provenance.library?.mainRelation ?? null,
    },
    benchCommit: doc.provenance.commit,
    host: {
      os: doc.provenance.os, arch: doc.provenance.arch,
      cpuModel: doc.provenance.cpuModel, ncpu: doc.provenance.ncpu,
      inContainer: doc.provenance.inContainer,
      emulated: doc.provenance.emulated,
      emulationEvidence: doc.provenance.emulationEvidence ?? [],
      fsType: doc.provenance.filesystem?.fsType ?? null,
      mountSource: doc.provenance.filesystem?.mountSource ?? null,
      bindMount: doc.provenance.filesystem?.bindMount ?? null,
      loadAverage: doc.provenance.loadAverage ?? null,
      rustc: doc.provenance.node?.rustc ?? null,
      buildProfile: doc.provenance.node?.buildProfile ?? null,
      lockfileHash: doc.provenance.lockfileHash ?? null,
    },
    measurement: doc.measurement,
    series: config.families.storage.seriesOrder,
    samples, skipped,
    invariants,
    modelled: doc.modelled ?? [],
    replicate: doc.replicate ?? null,
    cellCounts: {
      total: doc.cells.length,
      measured: doc.cells.filter((c) => c.outcome === 'ok').length,
      notMeasured: doc.cells.filter((c) => c.outcome !== 'ok').length,
      lowConfidence: doc.cells.filter((c) => c.outcome === 'ok' && c.confidence !== 'high').length,
      timerSaturated: doc.cells.filter((c) => c.outcome === 'ok' && c.timerSaturated === true).length,
      replicated,
    },
  };
}

/** The archive index is the canonical id for a document; the document itself
 *  carries a null runId. Reading it back by digest also checks that the file on
 *  disk is the file the archive says it is. */
function runIdFromArchiveIndex(doc) {
  const p = flag('archive-index');
  if (!p) return null;
  const index = JSON.parse(readFileSync(resolve(p), 'utf8'));
  const hit = index.find((e) => e.documentDigest === doc.integrity.document);
  if (!hit) {
    refuse(`the archive index at ${p} has no entry whose documentDigest is ${doc.integrity.document}, ` +
      'so this document is not the one the archive recorded');
  }
  return hit.runId;
}

function deriveRunId(doc) {
  const stamp = String(doc.startedAt).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lib = (doc.provenance.library?.commit ?? 'unknown').slice(0, 40);
  return `${stamp}-${lib}-${doc.integrity.document.slice(7, 15)}`;
}

// ---------------------------------------------------------------------------
// engines
// ---------------------------------------------------------------------------

function enginesEntry(exportPath, attestationPath) {
  const raw = readFileSync(exportPath);
  const rows = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(rows) || rows.length === 0) refuse(`${exportPath} holds no rows`);

  if (!attestationPath || !existsSync(attestationPath)) {
    refuse('the engines export carries no provenance of its own, so it needs an --engines-attestation sidecar. ' +
      'Guessing the host it ran on is exactly the thing this page will not do.');
  }
  const att = JSON.parse(readFileSync(attestationPath, 'utf8'));
  for (const need of ['attestedBy', 'attestedAt', 'statement', 'library', 'benchCommit', 'host']) {
    if (att[need] === undefined) refuse(`the attestation at ${attestationPath} carries no "${need}"`);
  }

  const digest = sha256(raw);
  const stamp = String(att.capturedAt ?? att.attestedAt).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const runId = `${stamp}-${String(att.library.commit).slice(0, 40)}-${digest.slice(7, 15)}`;

  const suppressed = new Set(Object.keys(config.families.engines.suppressedMetrics ?? {}));
  const blockers = [
    'the family is not gateable: one measurement per cell, no repetitions, so there is no dispersion to read a verdict off',
    'the run\'s provenance is attested rather than observed',
  ];

  const METRICS = [
    ['build.wall', 'wall_time_ms', 'ms', 'lower-is-better'],
    ['build.tiles_per_s', 'tiles_per_second', '1/s', 'higher-is-better'],
    ['build.tracked_mb', 'tracked_memory_mb', 'MB', 'lower-is-better'],
    ['build.peak_rss_mb', 'peak_rss_mb', 'MB', 'lower-is-better'],
  ];

  const samples = [];
  const invariants = [];
  for (const r of rows) {
    const cell = `${r.width}x${r.height}@${r.concurrency}`;
    for (const [key, field, unit, direction] of METRICS) {
      if (suppressed.has(key)) continue;
      const v = r[field];
      if (!Number.isFinite(v)) continue;
      samples.push({
        series: r.engine, cell, scale: r.megapixels, source: 'synthetic',
        scenario: 'build', metric: key.split('.')[1], key,
        unit, direction, replicateIndex: 0,
        concurrency: r.concurrency,
        reps: 1, minReps: 1,
        median: v, min: v, max: v, p95: null,
        cov: null, ci95: null, ciHalfWidthPct: null,
        confidence: 'low',
        lowConfidenceReasons: ['one measurement per cell, so there is no dispersion to read'],
        timerSaturated: false,
        quietHost: att.host.quiet ?? null,
        gated: false,
        gateBlockers: blockers,
      });
    }
    invariants.push({
      series: r.engine, library: r.engine, scale: r.megapixels, source: 'synthetic',
      cell, name: 'tiles_produced', value: r.tiles_produced, unit: 'count',
    });
  }

  return {
    runId,
    family: 'engines',
    source: 'libviprs-bench',
    runner: config.families.engines.runner,
    profile: att.profile ?? 'scalability',
    capturedAt: att.capturedAt ?? att.attestedAt,
    capturedAtSource: att.capturedAt ? 'attested' : 'attestation timestamp',
    finishedAt: null,
    documentDigest: digest,
    integrity: { document: digest, note: 'sha256 of the raw export as committed at ' + att.exportPath },
    provenanceSource: 'attested',
    attestation: att,
    importedBy: 'benchmarks/tools/history-from-capture.mjs (stopgap for libviprs-bench#77)',
    library: att.library,
    benchCommit: att.benchCommit,
    host: att.host,
    measurement: att.measurement ?? {
      unit: 'one-process-per-sweep',
      isolation: 'shared-process',
      reps: { build: 1 },
      minReps: { build: 1 },
      clock: 'std::time::Instant',
      warmup: { policy: 'none', passes: 0 },
      interval: { statistic: 'single sample', method: 'none', level: null, resamples: 0 },
      pageCache: 'warm-unknown',
    },
    series: config.families.engines.seriesOrder,
    samples,
    skipped: [],
    invariants,
    modelled: [],
    replicate: null,
    cellCounts: {
      total: samples.length,
      measured: samples.length,
      notMeasured: 0,
      lowConfidence: samples.length,
      timerSaturated: 0,
      replicated: 0,
    },
    suppressedMetrics: config.families.engines.suppressedMetrics ?? {},
  };
}

// ---------------------------------------------------------------------------

const out = [];
const storagePath = flag('storage');
if (storagePath) out.push(storageEntry(resolve(storagePath)));

const enginesPath = flag('engines');
if (enginesPath) out.push(enginesEntry(resolve(enginesPath), flag('engines-attestation') ? resolve(flag('engines-attestation')) : null));

if (out.length === 0) refuse('nothing to import: pass --storage and/or --engines');

out.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

for (const r of out) {
  console.log(`${r.family.padEnd(8)} ${r.runId}`);
  console.log(`         ${r.samples.length} sample(s), ${r.skipped.length} that produced no number, ${r.invariants.length} invariant(s)`);
  console.log(`         provenance ${r.provenanceSource}, digest ${r.documentDigest}`);
}
console.log(`\nwrote ${outPath}`);
