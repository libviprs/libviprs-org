#!/usr/bin/env node
/* Regression test for issue #53: gen-op-sections must substitute {flag}
 * placeholders in an ANNOTATED op family's Rust body (not emit literal
 * {mask}/{operation} tokens). Runs the generator against committed fixtures
 * that exercise the manifest branch. Exit 1 on any unresolved placeholder. */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const HERE = __dirname;
const out = execFileSync('node', [
  path.join(HERE, 'index.js'),
  '--dump', path.join(HERE, 'fixtures.annotated-dump.json'),
  '--manifest', path.join(HERE, 'fixtures.annotated-manifest.json'),
], { encoding: 'utf8' });
// The Rust body must contain the substituted call and NO literal {…} tokens.
const leftover = out.match(/\{(operation|mask)\}/g) || [];
if (leftover.length) {
  console.error(`#53 FAIL: ${leftover.length} unsubstituted placeholder(s) in generated Rust body: ${leftover.join(', ')}`);
  process.exit(1);
}
if (!/try_morph\(&amp;mask, &quot;erode&quot;\)/.test(out) && !/try_morph\(&amp;mask, "erode"\)/.test(out)) {
  console.error('#53 FAIL: expected substituted try_morph(&mask, "erode") not found');
  process.exit(1);
}
console.log('ok: #53 placeholder substitution — annotated op body renders real values, no literal {…} tokens');
