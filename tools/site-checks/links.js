#!/usr/bin/env node
/* libviprs-org/tools/site-checks/links.js
 *
 * TEST: every_internal_link_resolves_to_a_file_that_exists
 *
 * GitHub Pages serves libviprs.org straight out of this repository, so a
 * relative path that points at nothing is a live 404 for a reader rather than
 * a red build for me. Nothing checked those paths before, and libviprs-org#74
 * moves a whole article down a level, which is precisely the change that
 * breaks one.
 *
 * So this walks every HTML file in the repo, pulls every href and src out of
 * it, resolves each one the way a browser would (against the file's own
 * directory, or against the repo root for a leading slash, since the apex of
 * libviprs.org is this repo root) and asserts the target is on disk. A
 * directory reference resolves to its index.html, which is what Pages serves.
 *
 * The wrong implementations it goes red against:
 *
 *   - the article moved to benchmarks/libvips/ with the four inbound
 *     references left alone: three navs and the clipping card then point at
 *     benchmarks/, and with the article gone from there they resolve to a
 *     directory with no index.html in it
 *   - the article moved with its `../` references left at one level:
 *     ../topbar.css then resolves to benchmarks/topbar.css and misses, and so
 *     do the four favicons, ../topbar.js and the brand link
 *   - a placeholder at benchmarks/ that links to the comparison as
 *     libvips/index.html when the directory is really called something else
 *
 * Plain Node, no dependency and no build step, which libviprs-org#62 asks for
 * explicitly.
 *
 * Usage:
 *   node tools/site-checks/links.js     # exit 1 on any unresolved reference
 *
 * Also require()-able: `check()` returns the findings as an array, and
 * `htmlFiles()` / `refsIn()` are reusable by the other site checks.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Directories that are never part of the published site.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', '.github']);

// Anything with a scheme, a protocol-relative host, or a pure fragment is not
// ours to resolve. `mailto:`, `data:`, `https:` and `//cdn...` all land here.
const NOT_OURS = /^(?:[a-z][a-z0-9+.\-]*:|\/\/|#)/i;

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

function htmlFiles(dir) {
  const base = dir || ROOT;
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(d, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        out.push(path.relative(ROOT, path.join(d, entry.name)));
      }
    }
  })(base);
  return out.sort();
}

// Blank out a region while keeping its newlines, so line numbers stay honest.
function blank(text, re) {
  return text.replace(re, (m) => m.replace(/[^\n]/g, ''));
}

// href/src inside <script> or <style> bodies and inside comments are not
// markup, so they are blanked before the attributes are read. The opening
// tags survive: `<script src="js/x.js">` is a real reference.
function markupOnly(text) {
  let t = blank(text, /<!--[\s\S]*?-->/g);
  t = t.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi, (m, open, body, close) =>
    open + body.replace(/[^\n]/g, '') + close);
  t = t.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (m, open, body, close) =>
    open + body.replace(/[^\n]/g, '') + close);
  return t;
}

function refsIn(html) {
  const text = markupOnly(html);
  const re = /\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = m[2] !== undefined ? m[2] : m[3];
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ attr: m[1].toLowerCase(), value, line });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

// Returns the absolute path a browser would fetch, or null when the reference
// is not ours to resolve.
function resolve(fileRel, value) {
  const raw = String(value).trim();
  if (raw === '' || NOT_OURS.test(raw)) return null;

  // Drop the fragment and the query; neither selects a file.
  const bare = raw.split('#')[0].split('?')[0];
  if (bare === '') return null;

  let target = bare.startsWith('/')
    ? path.join(ROOT, bare)
    : path.resolve(ROOT, path.dirname(fileRel), bare);

  // A directory reference is served as its index.html. That covers an explicit
  // trailing slash, a bare `.` or `..`, and a directory named without one.
  const looksLikeDir =
    bare.endsWith('/') || bare === '.' || bare === '..' || bare.endsWith('/.') || bare.endsWith('/..');
  if (looksLikeDir) return path.join(target, 'index.html');
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    return path.join(target, 'index.html');
  }
  return target;
}

function check() {
  const findings = [];
  for (const fileRel of htmlFiles()) {
    const html = fs.readFileSync(path.join(ROOT, fileRel), 'utf8');
    for (const ref of refsIn(html)) {
      const target = resolve(fileRel, ref.value);
      if (target === null) continue;
      if (!fs.existsSync(target)) {
        findings.push({
          file: fileRel,
          line: ref.line,
          attr: ref.attr,
          value: ref.value,
          resolved: path.relative(ROOT, target),
        });
      }
    }
  }
  return findings;
}

module.exports = { ROOT, htmlFiles, refsIn, resolve, check, markupOnly };

if (require.main === module) {
  const files = htmlFiles();
  const findings = check();
  let counted = 0;
  for (const fileRel of files) {
    counted += refsIn(fs.readFileSync(path.join(ROOT, fileRel), 'utf8')).length;
  }
  console.log(
    'every_internal_link_resolves_to_a_file_that_exists: ' +
      files.length + ' page(s), ' + counted + ' href/src attribute(s)');

  if (findings.length === 0) {
    console.log('ok: every internal reference resolves to a file that exists');
    process.exit(0);
  }
  for (const f of findings) {
    console.error(
      'BROKEN  ' + f.file + ':' + f.line + '  ' + f.attr + '="' + f.value + '"  ->  ' + f.resolved);
  }
  console.error('');
  console.error(findings.length + ' unresolved reference(s). Each one is a live 404 on libviprs.org.');
  process.exit(1);
}
