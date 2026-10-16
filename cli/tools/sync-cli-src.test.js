#!/usr/bin/env node
/* cli/tools/sync-cli-src.test.js
 *
 * libviprs-org#93, #94: sync-cli-src.sh --check has to read every libviprs-cli
 * source file that defines a flag, and has to fail when a file defines one and
 * it does not read it.
 *
 * It builds a throwaway libviprs-org/libviprs-cli pair in a temp dir (the script
 * finds the canonical source relative to itself, so it cannot be pointed
 * elsewhere), puts the real script next to a list of its own, and runs --check.
 * --check writes nothing and needs neither cargo nor node, so this runs
 * anywhere bash does.
 *
 * Run by test-flags/test.js, so CI and the pre-commit hook reach it without a
 * new step.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'sync-cli-src.sh');

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

/** A tree where the frozen copy equals the canonical source. */
function fixture(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-cli-src-'));
  const canon = {
    'main.rs': '// @doc-flag: tile-size kind=param param_name=tile-size\nfn main() {}\n',
    'pipeline.rs': '// @doc-flag: resume kind=append\n#[arg(long)]\npub resume: bool,\n',
    'input.rs': 'pub fn decode() {}\n',
    'ops/mod.rs': 'pub mod core;\n',
    ...extra,
  };
  for (const [rel, text] of Object.entries(canon)) {
    write(root, `libviprs-cli/src/${rel}`, text);
    // Only what the list names (and ops/) is frozen; the rest is canonical-only.
    if (['main.rs', 'pipeline.rs'].includes(rel) || rel.startsWith('ops/')) {
      write(root, `libviprs-org/cli/rust/${rel}`, text);
    }
  }
  write(root, 'libviprs-org/cli/tools/sync-cli-src.sh', fs.readFileSync(SCRIPT, 'utf8'));
  fs.chmodSync(path.join(root, 'libviprs-org/cli/tools/sync-cli-src.sh'), 0o755);
  write(root, 'libviprs-org/cli/tools/cli-source-files.txt', '# test list\nmain.rs\npipeline.rs\n');
  return root;
}

function check(root) {
  const r = spawnSync('bash', [path.join(root, 'libviprs-org/cli/tools/sync-cli-src.sh'), '--check'], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const cases = [
  {
    name: 'a frozen copy equal to the canonical source passes',
    run: () => fixture(),
    expect: (r) => r.code === 0,
  },
  {
    name: 'a listed file with no frozen copy fails (pipeline.rs dropped, #94)',
    run: () => {
      const root = fixture();
      fs.rmSync(path.join(root, 'libviprs-org/cli/rust/pipeline.rs'));
      return root;
    },
    expect: (r) => r.code === 1 && /pipeline\.rs/.test(r.out),
  },
  {
    name: 'a listed file that drifted fails (main.rs, #93)',
    run: () => {
      const root = fixture();
      fs.appendFileSync(path.join(root, 'libviprs-cli/src/main.rs'), '// upstream change\n');
      return root;
    },
    expect: (r) => r.code === 1 && /main\.rs/.test(r.out),
  },
  {
    name: 'an unlisted file with a clap #[arg(...)] fails and is named',
    run: () => fixture({ 'verify.rs': '#[arg(long)]\npub strict: bool,\n' }),
    expect: (r) => r.code === 1 && /verify\.rs/.test(r.out),
  },
  {
    name: 'an unlisted file with a #[command(...)] fails and is named',
    run: () => fixture({ 'plan.rs': '#[command(subcommand)]\npub sub: Sub,\n' }),
    expect: (r) => r.code === 1 && /plan\.rs/.test(r.out),
  },
  {
    name: 'an unlisted file with an @doc- marker fails and is named',
    run: () => fixture({ 'extra.rs': '// @doc-snippet: load\n' }),
    expect: (r) => r.code === 1 && /extra\.rs/.test(r.out),
  },
  {
    name: 'an unlisted file with no flags and no markers is fine',
    run: () => fixture({ 'helpers.rs': 'pub fn f() {}\n' }),
    expect: (r) => r.code === 0,
  },
];

let bad = 0;
for (const c of cases) {
  const root = c.run();
  const r = check(root);
  const ok = c.expect(r);
  console.log(`${ok ? 'ok   ' : 'FAIL '} ${c.name}`);
  if (!ok) {
    bad += 1;
    console.log(`       exit ${r.code}: ${r.out.split('\n').slice(0, 4).join(' | ')}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

if (bad) {
  console.error(`\n${bad} / ${cases.length} sync-cli-src cases failed`);
  process.exit(1);
}
console.log(`ok: ${cases.length} sync-cli-src case(s)`);
