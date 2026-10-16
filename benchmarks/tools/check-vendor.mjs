#!/usr/bin/env node
/**
 * check-vendor.mjs — the frozen dashboard has not been edited here.
 *
 * `benchmarks/vendor/` is a byte-for-byte copy of three files from
 * libviprs-bench. A copy nobody checks is a copy that diverges, which is the
 * failure this repository has already paid for once: a hand port of causl's
 * chart code drifted until a fix to either could not reach the other.
 *
 * The hashes are computed the way git hashes a blob, so a manifest entry can be
 * checked against `git ls-tree` in the source repository without cloning it.
 *
 *   node benchmarks/tools/check-vendor.mjs            verify, exit 1 on drift
 *   node benchmarks/tools/check-vendor.mjs --write    rewrite the manifest
 *   node benchmarks/tools/check-vendor.mjs --bench <libviprs-bench checkout>
 *                                                     also check the manifest against
 *                                                     the pinned revision's own blobs
 *
 * The first form catches a hand edit. It cannot catch a manifest rewritten to
 * match an edited file, or one taken from a revision nobody pinned, so --bench
 * asks the source repository what the blob is at BENCH_REV. That is the check
 * that stops this vendoring a head that has not landed.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, '..', 'vendor');
const MANIFEST = join(VENDOR, 'VENDOR.manifest');
const FILES = ['dashboard.js', 'dashboard.css', 'dashboard-config.json'];
/** Where each vendored file lives in libviprs-bench. */
const SOURCE = {
  'dashboard.js': 'tools/contract/generated/dashboard.js',
  'dashboard.css': 'tools/contract/upstream/dashboard.css',
  'dashboard-config.json': 'tools/contract/config.json',
};

/** The sha1 git would record for this file's contents. */
export function blobSha1(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

const actual = () => FILES.map((name) => [name, blobSha1(readFileSync(join(VENDOR, name)))]);

if (process.argv.includes('--write')) {
  const lines = actual().map(([name, sha]) => `${sha}  ${name}`);
  writeFileSync(MANIFEST, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  process.exit(0);
}

if (!existsSync(MANIFEST)) {
  // Refusing rather than reporting green: a missing manifest cannot check
  // anything, and a check that cannot run is not a pass.
  console.error(`check-vendor: refused, no manifest at ${MANIFEST}`);
  process.exit(3);
}

const expected = new Map(
  readFileSync(MANIFEST, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => { const [sha, name] = line.split(/\s+/); return [name, sha]; }),
);

let drifted = 0;
for (const [name, sha] of actual()) {
  const want = expected.get(name);
  if (want === undefined) {
    console.error(`check-vendor: ${name} is not in the manifest`);
    drifted++;
  } else if (want !== sha) {
    console.error(`check-vendor: ${name} drifted\n  manifest ${want}\n  actual   ${sha}`);
    drifted++;
  }
}
for (const name of expected.keys()) {
  if (!FILES.includes(name)) {
    console.error(`check-vendor: the manifest names ${name}, which is not vendored`);
    drifted++;
  }
}

// Against the source repository at the pinned revision.
const benchAt = process.argv.indexOf('--bench');
if (benchAt !== -1) {
  const bench = process.argv[benchAt + 1];
  if (!bench) {
    console.error('check-vendor: --bench needs a libviprs-bench checkout');
    process.exit(2);
  }
  const rev = readFileSync(join(HERE, '..', 'BENCH_REV'), 'utf8').trim();
  for (const name of FILES) {
    let theirs;
    try {
      theirs = execFileSync('git', ['-C', bench, 'rev-parse', `${rev}:${SOURCE[name]}`], { encoding: 'utf8' }).trim();
    } catch (e) {
      console.error(`check-vendor: ${SOURCE[name]} does not exist in libviprs-bench at ${rev}`);
      drifted++;
      continue;
    }
    if (theirs !== expected.get(name)) {
      console.error(`check-vendor: ${name} is not what libviprs-bench has at the pinned ${rev.slice(0, 12)}\n  manifest ${expected.get(name)}\n  upstream ${theirs}`);
      drifted++;
    }
  }
}
if (drifted === 0) console.log(`check-vendor: ${FILES.length} vendored files match the manifest${benchAt !== -1 ? ' and the pinned libviprs-bench revision' : ''}`);
process.exit(drifted > 0 ? 1 : 0);
