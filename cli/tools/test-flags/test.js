#!/usr/bin/env node
/* libviprs-org/cli/tools/test-flags/test.js
 *
 * Per-flag audit. For every flag in cli/js/snippets.generated.json, simulate
 * checking just that flag (at its default value) and diff the generated Rust
 * against the no-flags baseline. A flag that produces zero diff is BROKEN —
 * usually because it has an empty `fragment`, a `param` kind whose slot
 * doesn't reference its placeholder, or a slot the generator doesn't actually
 * route through.
 *
 * Inlines a faithful subset of cli/js/cli.js's renderFullProgram() pipeline:
 *   - imports union
 *   - per-slot param/append/appendChain/override
 *   - the sink-override URI dispatch
 * It does NOT mirror the post-hoc gutter attribution (that's cosmetic for
 * this purpose).
 *
 * Usage:
 *   node cli/tools/test-flags/test.js              # human-readable report
 *   node cli/tools/test-flags/test.js --markdown   # markdown table for PR
 *   node cli/tools/test-flags/test.js --json       # machine-readable
 *   node cli/tools/test-flags/test.js --diff <flag> # show the diff for one
 */
'use strict';

const fs = require('fs');
const path = require('path');

const JSON_PATH = path.join(__dirname, '..', '..', 'js', 'snippets.generated.json');

const ENUM_VARIANT = {
  'deep-zoom': 'DeepZoom', 'xyz': 'Xyz', 'google': 'Google',
  'png': 'Png', 'jpeg': 'Jpeg', 'raw': 'Raw',
  'blake3': 'Blake3', 'sha256': 'Sha256',
  'fail-fast': 'FailFast', 'retry-then-fail': 'RetryThenFail', 'retry-then-skip': 'RetryThenSkip',
  'error': 'ERROR', 'warn': 'WARN', 'info': 'INFO', 'debug': 'DEBUG', 'trace': 'TRACE',
};

function variantFor(value) {
  if (value == null) return '';
  if (Object.prototype.hasOwnProperty.call(ENUM_VARIANT, value)) return ENUM_VARIANT[value];
  return String(value);
}

// {placeholder} → params[placeholder]. Unknown placeholders are left in
// place (so a malformed JSON doesn't silently swallow them).
function substitute(text, params) {
  if (text == null) return '';
  return String(text).replace(/\{([^{}\n]+?)\}/g, function (m, key) {
    return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : m;
  });
}

function paramsForFlag(def, value) {
  const out = {};
  if (def && (def.param_name || def.param)) {
    out[(def.param_name || def.param)] = def.options ? variantFor(value) : value;
  }
  // Convenience aliases used by some fragments.
  if (value !== undefined) {
    out.v = value;
    out.value = value;
  }
  return out;
}

function mergeParams(...layers) {
  const out = {};
  for (const l of layers) for (const k in l) out[k] = l[k];
  return out;
}

function applyAppendChain(body, chains, params) {
  // body is a string (the slot's joined base lines). Locate the trailing `;`,
  // peel it off, append each chain fragment as `    .with_X(...)\n`, then
  // reattach `;`. Mirrors cli.js.
  const text = body || '';
  const lastSemi = text.lastIndexOf(';');
  let head = lastSemi >= 0 ? text.slice(0, lastSemi).replace(/\s*$/, '') : text.replace(/\s*$/, '');
  const tail = lastSemi >= 0 ? ';' : '';
  for (const c of chains) {
    const frag = substitute(c.def.fragment || '', mergeParams(params, paramsForFlag(c.def, c.value)));
    if (!frag) continue;
    const lines = frag.split('\n');
    head += '\n' + lines.map(l => '    ' + l).join('\n');
  }
  return head + (tail ? '\n    ' + tail : '');
}

function resolveSinkOverride(activeOverride) {
  const v = activeOverride.value || '';
  if (v.startsWith('s3://')) {
    const rest = v.slice(5);
    const slash = rest.indexOf('/');
    const bucket = slash < 0 ? rest : rest.slice(0, slash);
    return {
      body: 'let sink = libviprs::ObjectStoreSink::s3("' + bucket + '", plan.clone())?;',
      imports: ['ObjectStoreSink'],
    };
  }
  if (v.startsWith('packfile://')) {
    const p = v.slice(11);
    const fmt = (p.endsWith('.tar.gz') || p.endsWith('.tgz')) ? 'TarGz'
              : p.endsWith('.zip') ? 'Zip' : 'Tar';
    return {
      body: 'let sink = PackfileSink::new("' + p + '", PackfileFormat::' + fmt + ', plan.clone(), TileFormat::Png)?;',
      imports: ['PackfileSink', 'PackfileFormat'],
    };
  }
  return null;
}

function render(snippets, checkedFlags) {
  // Compose the active list with default values (or the user-supplied value).
  const flagsDef = snippets.flags || {};
  const active = Object.keys(checkedFlags).map((name) => {
    const def = flagsDef[name];
    if (!def) return null;
    let value = checkedFlags[name];
    if (value == null) {
      value = def.default != null ? String(def.default) : '';
    }
    return { name, def, value };
  }).filter(Boolean);

  // Bucket by slot.
  const bySlot = {};
  function bucket(slot) {
    if (!bySlot[slot]) bySlot[slot] = { params: [], appends: [], chains: [], overrides: [] };
    return bySlot[slot];
  }
  active.forEach((a) => {
    if (!a.def.kind || a.def.kind === 'imports-only' || !a.def.slot) return;
    const b = bucket(a.def.slot);
    if (a.def.kind === 'param') b.params.push(a);
    else if (a.def.kind === 'append') b.appends.push(a);
    else if (a.def.kind === 'appendChain') b.chains.push(a);
    else if (a.def.kind === 'override') b.overrides.push(a);
  });

  // Live params: each param flag contributes its current value, plus
  // defaults for inactive params so slot-base placeholders still render.
  const paramKey = (def) => def && (def.param_name || def.param);
  const liveParams = {};
  active.forEach((a) => {
    const k = paramKey(a.def);
    if (k) {
      liveParams[k] = a.def.options ? variantFor(a.value) : a.value;
    }
  });
  Object.keys(flagsDef).forEach((name) => {
    const f = flagsDef[name];
    const k = paramKey(f);
    if (!k) return;
    if (Object.prototype.hasOwnProperty.call(liveParams, k)) return;
    liveParams[k] = f.options ? variantFor(f.default) : (f.default != null ? f.default : '');
  });

  const extraImports = {};
  const activeNames = {};
  active.forEach((a) => { activeNames[a.name] = true; });
  const renderedSlots = [];
  (snippets.slot_order || []).forEach((slotName) => {
    const slot = snippets.slots && snippets.slots[slotName];
    if (!slot) return;
    if (slot.gated_by && slot.gated_by.length && !slot.gated_by.some((g) => activeNames[g])) {
      return;
    }
    const a = bySlot[slotName];

    if (a && a.overrides.length) {
      const o = a.overrides[a.overrides.length - 1];
      if (o.def.special === 'sink-override' || o.name === 'sink') {
        const r = resolveSinkOverride(o);
        if (r) {
          renderedSlots.push(r.body);
          r.imports.forEach((imp) => { extraImports[imp] = true; });
          return;
        }
      }
      const overrideText = substitute(o.def.fragment || '', mergeParams(liveParams, paramsForFlag(o.def, o.value)));
      renderedSlots.push(overrideText);
      return;
    }

    let body = (slot.lines || []).map((l) => substitute(l, liveParams)).join('\n');
    if (a && a.chains.length) body = applyAppendChain(body, a.chains, liveParams);
    if (a && a.appends.length) {
      a.appends.forEach((p) => {
        const frag = substitute(p.def.fragment || '', mergeParams(liveParams, paramsForFlag(p.def, p.value)));
        if (frag) body += (body ? '\n' : '') + frag;
      });
    }
    renderedSlots.push(body);
  });

  // Imports union.
  const importsSet = {};
  (snippets.imports_base || []).forEach((s) => { importsSet[s] = true; });
  active.forEach((a) => (a.def.imports_when_active || []).forEach((s) => { importsSet[s] = true; }));
  Object.keys(extraImports).forEach((s) => { importsSet[s] = true; });
  const imports = Object.keys(importsSet).sort();

  // Filter empty slots; join with blank lines like the page does.
  const nonEmpty = renderedSlots.filter((s) => s && s.trim().length);
  const innerBody = nonEmpty.map((s) => s.split('\n').map((l) => l.length ? '    ' + l : '').join('\n')).join('\n\n');

  let out = 'use libviprs::{' + imports.join(', ') + '};\n';
  out += 'use std::path::PathBuf;\n\n';
  out += 'fn main() -> Result<(), Box<dyn std::error::Error>> {\n';
  out += '    let input = PathBuf::from("/path/to/your/input.pdf");\n';
  out += '    let output = PathBuf::from("./tiles");\n';
  if (innerBody) out += '\n' + innerBody + '\n';
  out += '\n    Ok(())\n';
  out += '}\n';
  return out;
}

// Diagnostic for why a flag produced no diff.
function diagnose(name, def, slots) {
  if (!def.kind) return 'no kind set';
  if (def.kind === 'imports-only') return 'imports-only — no code change expected';
  if (!def.slot) return 'no slot set';
  if (def.kind === 'param') {
    const slot = slots[def.slot];
    if (!slot) return 'slot ' + def.slot + ' not found in JSON';
    const placeholder = '{' + (def.param_name || def.param) + '}';
    const matched = (slot.lines || []).some((l) => l.indexOf(placeholder) !== -1);
    return matched
      ? 'placeholder is present, but value matches default (try a non-default value)'
      : 'slot "' + def.slot + '" has no `' + placeholder + '` placeholder in its base lines';
  }
  if (def.kind === 'append' || def.kind === 'appendChain' || def.kind === 'override') {
    if (!def.fragment) return 'empty `fragment` (kind=' + def.kind + ')';
    return 'unknown — fragment is set but produces no diff';
  }
  return 'unknown kind ' + def.kind;
}

// SCHEMA v2: the manifest is command-scoped ({version:2, commands:{…}}). Return
// the list of [name, commandObj] to audit — every command that is interactive
// or carries slots. Falls back to a v1 (flat, pyramid-shaped) document.
function commandsToAudit(json) {
  if (json && json.commands && typeof json.commands === 'object') {
    return Object.keys(json.commands)
      .sort()
      .map((name) => [name, json.commands[name]])
      .filter(([, cmd]) => cmd && (cmd.interactive || (cmd.slots && Object.keys(cmd.slots).length)));
  }
  return [['pyramid', json]];
}

// For param-kind flags the default value is already folded into the baseline
// (so ticking at default produces zero diff — a false positive). Pick a clearly
// non-default value so substitution actually shows up.
function nonDefaultValue(def) {
  if (def.kind !== 'param') return def.default != null ? String(def.default) : '';
  if (def.options && def.options.length) {
    const variant = def.options.find((o) => String(o) !== String(def.default));
    return variant != null ? String(variant) : String(def.options[0]);
  }
  if (def.type === 'int') {
    const d = parseInt(def.default, 10);
    return Number.isNaN(d) ? '999' : String(d + 999);
  }
  return def.default ? def.default + ' (changed)' : 'changed';
}

// Audit one command object → array of per-flag results.
function auditCommand(command, cmdName) {
  const baseline = render(command, {});
  const flagNames = Object.keys(command.flags || {}).sort();
  return flagNames.map((name) => {
    const def = command.flags[name];
    const value = nonDefaultValue(def);
    const out = render(command, { [name]: value });
    const ok = out !== baseline;
    return {
      command: cmdName,
      name,
      kind: def.kind,
      slot: def.slot || '-',
      value,
      ok,
      why: ok ? '' : diagnose(name, def, command.slots || {}),
    };
  });
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--markdown') ? 'markdown'
             : args.includes('--json') ? 'json'
             : args.includes('--diff') ? 'diff'
             : 'human';
  const json = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const commands = commandsToAudit(json);

  if (mode === 'diff') {
    const flag = args[args.indexOf('--diff') + 1];
    // Find the flag in any audited command.
    const hit = commands.find(([, cmd]) => cmd.flags && cmd.flags[flag]);
    if (!flag || !hit) { console.error('flag not found'); process.exit(2); }
    const command = hit[1];
    const baseline = render(command, {});
    const def = command.flags[flag];
    const value = def.default != null ? String(def.default) : '';
    const out = render(command, { [flag]: value });
    console.log('--- baseline (' + hit[0] + ') ---'); console.log(baseline);
    console.log('--- with --' + flag + '=' + value + ' ---'); console.log(out);
    return;
  }

  const results = [];
  commands.forEach(([name, cmd]) => { results.push(...auditCommand(cmd, name)); });

  if (mode === 'json') {
    console.log(JSON.stringify(results, null, 2));
    process.exit(results.some((r) => !r.ok) ? 1 : 0);
  }
  if (mode === 'markdown') {
    console.log('| Command | Flag | Kind | Slot | Status | Notes |');
    console.log('|---|---|---|---|---|---|');
    results.forEach((r) => {
      console.log(`| \`${r.command}\` | \`--${r.name}\` | \`${r.kind}\` | \`${r.slot}\` | ${r.ok ? '✅ OK' : '❌ BROKEN'} | ${r.why || '—'} |`);
    });
    const broken = results.filter((r) => !r.ok);
    console.log('\n**Total:** ' + results.length + ' flags across ' + commands.length + ' command(s) · **Broken:** ' + broken.length);
    process.exit(broken.length ? 1 : 0);
  }

  // human mode
  const broken = results.filter((r) => !r.ok);
  results.forEach((r) => {
    const tag = r.ok ? '\x1b[32mOK     \x1b[0m' : '\x1b[31mBROKEN \x1b[0m';
    console.log(`${tag} [${r.command}] --${r.name}  (kind=${r.kind}, slot=${r.slot})${r.why ? '   →  ' + r.why : ''}`);
  });
  console.log('');
  console.log(broken.length + ' / ' + results.length + ' flags broken across ' + commands.length + ' command(s)');
  process.exit(broken.length ? 1 : 0);
}

main();
