#!/usr/bin/env node
/* libviprs-org/cli/tools/gen-op-sections/index.js — SCHEMA v2 §3.2
 *
 * Data-driven generator for the ~180 non-interactive op commands.
 *
 * Consumes:
 *   1. a `viprs __dump-commands --json` document (clap introspection, §3.1); and
 *   2. the v2 snippet manifest (cli/js/snippets.generated.json, §2).
 *
 * Emits, for every NON-interactive command, a self-contained HTML <section> in
 * the same visual style as the hand-authored sections:
 *   - <h2 id="<name>">                     → anchors libviprs.org/cli/#<name>
 *   - an `about` paragraph
 *   - a "Show Rust equivalent" example pair: a synthesized CLI line and a Rust
 *     body (from the command's annotated snippet in the manifest if present,
 *     else a generated `load → try_<op> → save` template)
 *   - a <dl class="flags"> of positionals + flags, each flag anchored as
 *     #<name>-flag-<long>
 *
 * Interactive / hand-authored commands (pyramid, info, plan, test-image) are
 * excluded — their HTML stays hand-authored (§3.2). The output is meant for the
 * <div id="generated-op-sections"></div> container in index.html.
 *
 * Usage:
 *   node index.js [--dump <dump.json>] [--manifest <manifest.json>]
 *                 [--out <file.html>] [--inject <index.html>]
 *
 *   (no --out/--inject)  → writes the fragment to stdout
 *   --out <file>         → writes the fragment to <file>
 *   --inject <index>     → replaces the contents of <div id="generated-op-sections">
 *                          in <index> with the generated fragment (build step)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const DEFAULT_DUMP = path.join(HERE, 'sample-dump.json');
const DEFAULT_MANIFEST = path.join(HERE, '..', '..', 'js', 'snippets.generated.json');

// Commands whose HTML is hand-authored & interactive — never generated (§3.2).
const HAND_AUTHORED = new Set(['pyramid', 'info', 'plan', 'test-image']);

// The closed vocabularies a generated command's metadata must belong to
// (SCHEMA_V2 §3.1 shapes + §5 / OP_MAP oracle classes). A dump command that
// contradicts them (e.g. rank tagged oracle "APPROX") fails the build loud.
const VALID_ORACLE_CLASSES = new Set([
  'EXACT', 'EXACT-AFTER-CAST', 'BOUNDED-TOL', 'FOURIER',
  'GOLDEN-ONLY', 'EXCLUDED', 'DEFERRED',
]);
const VALID_SHAPES = new Set([
  'image->image', 'n-image->image', 'image->stdout-scalar',
  'image->two-outputs', 'creator', 'draw',
]);

// Throw with a specific diagnostic if any generated command's oracle_class or
// shape is outside the closed vocabulary (§3.1 / §5). Only the commands we
// actually render are validated — builtins (null shape/oracle) are excluded
// upstream by the interactive/hand-authored filter.
function validateCommands(commands) {
  const errors = [];
  commands.forEach((c) => {
    if (!VALID_ORACLE_CLASSES.has(c.oracle_class)) {
      errors.push(`command '${c.name}': invalid oracle_class ${JSON.stringify(c.oracle_class)} (expected one of ${[...VALID_ORACLE_CLASSES].join(', ')})`);
    }
    if (!VALID_SHAPES.has(c.shape)) {
      errors.push(`command '${c.name}': invalid shape ${JSON.stringify(c.shape)} (expected one of ${[...VALID_SHAPES].join(', ')})`);
    }
  });
  if (errors.length) {
    throw new Error('gen-op-sections validation failed:\n  ' + errors.join('\n  '));
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

// A representative CLI invocation from positionals + a couple of flags.
function cliLine(cmd) {
  const parts = ['viprs', cmd.name];
  (cmd.positionals || []).forEach((p) => {
    parts.push(p.name.toLowerCase() + (/out/i.test(p.name) ? '.v' : '.png'));
  });
  // Show at most the first two flags with a representative value.
  (cmd.flags || []).slice(0, 2).forEach((f) => {
    let v;
    if (f.possible_values && f.possible_values.length) v = f.possible_values[0];
    else if (f.default != null) v = f.default;
    else v = f.value_name || 'VALUE';
    if (f.takes_value === false) parts.push('--' + f.long);
    else parts.push('--' + f.long + ' ' + v);
  });
  return parts.join(' ');
}

// A representative value for a flag, for both the CLI line and placeholder
// substitution: the first enum choice, else the default, else the value_name.
function representativeValue(f) {
  if (f.possible_values && f.possible_values.length) return f.possible_values[0];
  if (f.options && f.options.length) return f.options[0];
  if (f.default != null && f.default !== '') return f.default;
  return f.value_name || (f.long ? f.long.toUpperCase() : 'VALUE');
}

// Build the `{param_name}` → value map used to render an annotated snippet's
// Rust body, mirroring cli.js's substitute(): op-family snippet lines carry
// `{flag}` placeholders keyed by each flag's `param_name` (manifest) — resolve
// them from the manifest command's flags, then from the dump command's flags.
function placeholderParams(cmd, manifestCommand) {
  const params = {};
  const mflags = (manifestCommand && manifestCommand.flags) || {};
  Object.keys(mflags).forEach((key) => {
    const f = mflags[key];
    params[f.param_name || key] = representativeValue(f);
  });
  (cmd.flags || []).forEach((f) => {
    if (params[f.long] == null) params[f.long] = representativeValue(f);
  });
  return params;
}

// Substitute `{key}` tokens (cli.js convention: [A-Za-z_][A-Za-z0-9_-]*) with
// the params map; leave any unresolved token verbatim (as cli.js does).
function substitutePlaceholders(text, params) {
  return String(text).replace(/\{([a-zA-Z_][a-zA-Z0-9_-]*)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole);
}

// The Rust body: prefer an annotated snippet from the manifest; else a generated
// load → try_<op> → save template (§3.2).
function rustBody(cmd, manifestCommand) {
  if (manifestCommand && manifestCommand.slots && manifestCommand.slot_order) {
    const lines = [];
    manifestCommand.slot_order.forEach((slotId) => {
      const slot = manifestCommand.slots[slotId];
      if (slot && slot.lines) lines.push(...slot.lines);
    });
    if (lines.length) {
      // #53: substitute {flag} placeholders (like cli.js) so a generated
      // "Rust equivalent" for an annotated op family renders real values, not
      // literal {mask}/{operation} tokens.
      const params = placeholderParams(cmd, manifestCommand);
      return lines.map((l) => substitutePlaceholders(l, params)).join('\n');
    }
  }
  // Generated template.
  const fn = 'try_' + cmd.name.replace(/-/g, '_');
  const producesOut = (cmd.positionals || []).some((p) => /out/i.test(p.name));
  const flagArgs = (cmd.flags || [])
    .filter((f) => f.takes_value !== false)
    .map((f) => f.long.replace(/-/g, '_'))
    .join(', ');
  const call = flagArgs ? `raster.${fn}(${flagArgs})?` : `raster.${fn}()?`;
  const out = [];
  out.push('let raster = decode_file(&input)?;');
  if (producesOut) {
    out.push(`let result = ${call};`);
    out.push('save_file(&result, &output)?;');
  } else {
    out.push(`let value = ${call};`);
    out.push('println!("{value}");');
  }
  return out.join('\n');
}

function renderFlagRow(cmdName, f) {
  const id = `${cmdName}-flag-${f.long}`;
  const short = f.short ? `, <code>-${esc(f.short)}</code>` : '';
  const valuePart = f.takes_value === false ? '' : ' <code>&lt;' + esc(f.value_name || 'VALUE') + '&gt;</code>';
  const bits = [];
  bits.push(`<dt id="${esc(id)}"><code>--${esc(f.long)}</code>${short}${valuePart}</dt>`);
  const desc = [];
  desc.push('<p>' + esc(f.help || '') + (f.required ? ' <span class="required-val">Required.</span>' : ''));
  if (f.possible_values && f.possible_values.length) {
    desc.push(' <span class="enum-val">One of: ' + f.possible_values.map((v) => '<code>' + esc(v) + '</code>').join(', ') + '.</span>');
  }
  if (f.default != null && f.default !== '') {
    desc.push(' <span class="default-val">Default: ' + esc(f.default) + '</span>');
  }
  desc.push('</p>');
  bits.push('<dd>' + desc.join('') + '</dd>');
  return bits.join('\n    ');
}

function renderPositionalRow(p) {
  return [
    `<dt><code>&lt;${esc(p.name)}&gt;</code></dt>`,
    '<dd><p>' + esc(p.help || '') + (p.required ? ' <span class="required-val">Required.</span>' : '') + '</p></dd>',
  ].join('\n    ');
}

function renderSection(cmd, manifestCommand) {
  const rows = [];
  (cmd.positionals || []).forEach((p) => rows.push(renderPositionalRow(p)));
  (cmd.flags || []).forEach((f) => rows.push(renderFlagRow(cmd.name, f)));

  const meta = [cmd.family, cmd.shape, cmd.oracle_class].filter(Boolean).map(esc).join(' &middot; ');

  return `<section class="op-section" data-command="${esc(cmd.name)}">
  <h2 id="${esc(cmd.name)}">${esc(cmd.name)}</h2>
  <p>${esc(cmd.about || '')}</p>
  ${meta ? `<p class="op-meta">${meta}</p>` : ''}

  <div class="cmd-base-setup">
    <button type="button" class="cmd-base-setup-toggle" aria-expanded="false">Show Rust equivalent</button>
    <div class="cmd-base-setup-body">
      <div class="code-wrap">
        <button class="copy-btn">&#x2398; Copy</button>
        <pre><code class="language-shell">${esc(cliLine(cmd))}</code></pre>
      </div>
      <div class="code-wrap">
        <button class="copy-btn">&#x2398; Copy</button>
        <pre><code class="language-rust">${esc(rustBody(cmd, manifestCommand))}</code></pre>
      </div>
    </div>
  </div>

  <dl class="flags">
    ${rows.join('\n\n    ')}
  </dl>
</section>`;
}

function generate(dump, manifest) {
  const manifestCommands = (manifest && manifest.commands) || {};
  const commands = (dump.commands || [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((c) => {
      const mc = manifestCommands[c.name];
      if (mc && mc.interactive) return false;   // interactive → hand-authored
      if (HAND_AUTHORED.has(c.name)) return false;
      return true;
    });

  // Validate the closed metadata vocabularies before rendering (B5).
  validateCommands(commands);

  const sections = commands.map((c) => renderSection(c, manifestCommands[c.name]));
  return { names: commands.map((c) => c.name), html: sections.join('\n\n') };
}

function injectInto(indexHtml, fragment) {
  const openTag = '<div id="generated-op-sections">';
  const openIdx = indexHtml.indexOf(openTag);
  if (openIdx < 0) {
    throw new Error('injection container <div id="generated-op-sections"> not found in index.html');
  }
  // Find the container's matching </div> by depth-counting <div>/</div> from
  // just after the open tag — robust to the nested <div>s the fragment adds, so
  // re-injecting into an already-populated container is safe & idempotent.
  const bodyStart = openIdx + openTag.length;
  const tagRe = /<div\b|<\/div>/g;
  tagRe.lastIndex = bodyStart;
  let depth = 1;
  let closeStart = -1;
  let m;
  while ((m = tagRe.exec(indexHtml)) !== null) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) { closeStart = m.index; break; }
  }
  if (closeStart < 0) {
    throw new Error('unbalanced <div> — could not find the matching </div> for the container');
  }
  return indexHtml.slice(0, bodyStart)
    + `\n${fragment}\n`
    + indexHtml.slice(closeStart);
}

function main() {
  const dumpPath = arg('--dump', DEFAULT_DUMP);
  const manifestPath = arg('--manifest', DEFAULT_MANIFEST);
  const outPath = arg('--out', null);
  const injectPath = arg('--inject', null);

  const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const { names, html } = generate(dump, manifest);
  const fragment = '<!-- BEGIN generated op sections (tools/gen-op-sections) -->\n'
    + html
    + '\n<!-- END generated op sections -->';

  if (injectPath) {
    const idx = fs.readFileSync(injectPath, 'utf8');
    fs.writeFileSync(injectPath, injectInto(idx, fragment));
    console.error(`injected ${names.length} op section(s) into ${injectPath}: ${names.join(', ')}`);
    return;
  }
  if (outPath) {
    fs.writeFileSync(outPath, fragment + '\n');
    console.error(`wrote ${names.length} op section(s) to ${outPath}: ${names.join(', ')}`);
    return;
  }
  process.stdout.write(fragment + '\n');
  console.error(`generated ${names.length} op section(s): ${names.join(', ')}`);
}

main();
