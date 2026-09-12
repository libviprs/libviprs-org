#!/usr/bin/env node
/* libviprs-org/benchmarks/tools/bench-drift.js
 *
 * Drift gate for /benchmarks/, the one data-driven artifact on this site that
 * keeps a hand-maintained duplicate of itself.
 *
 * Each of the three tables on that page exists twice. The live copy is
 * rendered from JSON by benchmarks/js/scalability-tables.js. The other copy is
 * the static <tbody> committed in benchmarks/index.html, which is what a
 * visitor sees with JS off, on a file:// preview, or when a fetch fails. The
 * whole job of the static copy is to say the same thing as the render, and
 * nothing enforced that: an unattended period left five stale cells (three
 * engine labels and two rounded megapixel figures) plus one structural drift
 * (the static rows wrapped a column in <code> and the JSON entries did not, so
 * the live page silently lost that styling on three rows).
 *
 * So this compares them, cell for cell. It builds the same models the renderer
 * paints — by require()ing the renderer, not by reimplementing its formatting,
 * so there is no third copy to drift — and checks them against the markup:
 *
 *   - caption text
 *   - header cells, in order
 *   - every body row: cell count, th-vs-td, and each cell's content after
 *     entity decoding and whitespace collapsing (so &mdash; and — are the same
 *     thing, and &nbsp; and a space are the same thing, but a missing <code>,
 *     a wrong swatch class, a wrong href or a missing pending marker are not)
 *   - the row-pending class on exactly the rows the data says are pending
 *   - the [data-bench-note] paragraph: present when the table has pending
 *     rows, carrying the note text the JSON supplies, and hidden otherwise
 *
 * This is a comparison, not a DOM. It needs no dependency and no build step,
 * which #62 asks for explicitly.
 *
 * Usage:
 *   node benchmarks/tools/bench-drift.js      # exit 1 on any drift
 *
 * Also require()-able: `check(overrides)` returns the findings as an array,
 * which is what benchmarks/tools/bench-drift.test.js uses to prove this gate
 * can actually fail.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const HTML = path.join(ROOT, 'benchmarks', 'index.html');
const DATA = path.join(ROOT, 'benchmarks', 'data');
const RENDERER = path.join(ROOT, 'benchmarks', 'js', 'scalability-tables.js');

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', mdash: '—', ndash: '–', times: '×',
  dagger: '†', micro: 'µ', sup2: '²', rarr: '→',
  larr: '←', middot: '·', hellip: '…', deg: '°',
  minus: '−', divide: '÷', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (whole, body) {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const hit = NAMED[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

/* Two cells say the same thing when they decode to the same characters and
 * carry the same markup. Entity spelling and line wrapping are free; a tag, an
 * attribute value or a character are not. U+00A0 counts as whitespace so
 * `2,944&nbsp;tiles/s` and `2,944 tiles/s` compare equal — the non-breaking
 * space is a typesetting choice the JSON does not carry. */
function norm(html) {
  return decodeEntities(html)
    .replace(/[\s ]+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

// ---------------------------------------------------------------------------
// Pulling the static copy out of the markup
// ---------------------------------------------------------------------------

function extractTables(html) {
  const tables = {};
  const tableRe = /<table\b[^>]*\bdata-bench-table="([^"]+)"[^>]*>([\s\S]*?)<\/table>/g;
  let m;
  while ((m = tableRe.exec(html)) !== null) {
    const which = m[1];
    const inner = m[2];

    const cap = /<caption\b[^>]*>([\s\S]*?)<\/caption>/.exec(inner);

    const theadBlock = /<thead\b[^>]*>([\s\S]*?)<\/thead>/.exec(inner);
    const headers = [];
    if (theadBlock) {
      const thRe = /<th\b[^>]*>([\s\S]*?)<\/th>/g;
      let th;
      while ((th = thRe.exec(theadBlock[1])) !== null) headers.push(th[1]);
    }

    const tbodyBlock = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/.exec(inner);
    const rows = [];
    if (tbodyBlock) {
      const trRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g;
      let tr;
      while ((tr = trRe.exec(tbodyBlock[1])) !== null) {
        const attrs = tr[1];
        const cells = [];
        const cellRe = /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/g;
        let cell;
        while ((cell = cellRe.exec(tr[2])) !== null) {
          cells.push({ tag: cell[1], attrs: cell[2], html: cell[3] });
        }
        rows.push({ pending: /\bclass="[^"]*\brow-pending\b/.test(attrs), cells: cells });
      }
    }

    tables[which] = { caption: cap ? cap[1] : null, headers: headers, rows: rows };
  }
  return tables;
}

function extractNotes(html) {
  const notes = {};
  const re = /<(\w+)\b([^>]*\bdata-bench-note="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    notes[m[3]] = { attrs: m[2], html: m[4], hidden: /\bhidden\b/.test(m[2]) };
  }
  return notes;
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
}

/* `overrides` lets the test feed doctored inputs in without touching the repo:
 * { html, scalability, scenarios, pmtiles }. Anything absent is read from disk.
 * Returns an array of finding strings; empty means no drift. */
function check(overrides) {
  const o = overrides || {};
  const M = require(RENDERER);
  const html = o.html !== undefined ? o.html : fs.readFileSync(HTML, 'utf8');
  const scenarios = o.scenarios !== undefined ? o.scenarios : readJson('engine-scenarios.json');
  const scalability = o.scalability !== undefined ? o.scalability : readJson('scalability_results.json');
  const pmtilesDoc = o.pmtiles !== undefined ? o.pmtiles : readJson('pmtiles_results.json');

  const findings = [];
  const fail = function (s) { findings.push(s); };

  let storageRows;
  try {
    storageRows = M.readStorageRows(pmtilesDoc);
  } catch (e) {
    fail('pmtiles_results.json is not a shape the renderer accepts: ' + e.message);
    return findings;
  }

  const results = M.singleThread(scalability);
  const showcaseMp = M.pickShowcaseMp(results, scenarios.engine_table && scenarios.engine_table.showcase_mp_target);

  const staticTables = extractTables(html);
  const staticNotes = extractNotes(html);

  const models = {
    engines: M.engineTableModel(results, scenarios, showcaseMp),
    scenarios: M.scenarioTableModel(results, scenarios, showcaseMp),
    storage: M.storageTableModel(storageRows, scenarios, !!staticNotes.storage),
  };

  // A parse that quietly found nothing would make every other assertion
  // vacuous, so the shape of what was parsed is itself checked first.
  for (const which of Object.keys(models)) {
    const model = models[which];
    if (!model) { fail('[' + which + '] the renderer produced no model for this table'); continue; }
    const stat = staticTables[which];
    if (!stat) { fail('[' + which + '] no <table data-bench-table="' + which + '"> in benchmarks/index.html'); continue; }
    if (stat.headers.length === 0) fail('[' + which + '] the static table has no header cells');
    if (stat.rows.length === 0) fail('[' + which + '] the static table has no body rows');
    if (model.rows.length === 0) fail('[' + which + '] the model produced no rows');
  }
  if (findings.length) return findings;

  for (const which of Object.keys(models)) {
    const model = models[which];
    const stat = staticTables[which];

    if (model.caption != null) {
      if (norm(stat.caption || '') !== norm(model.caption)) {
        fail('[' + which + '] caption: static ' + JSON.stringify(norm(stat.caption || '')) +
             ' vs render ' + JSON.stringify(norm(model.caption)));
      }
    }

    if (model.headers) {
      if (stat.headers.length !== model.headers.length) {
        fail('[' + which + '] header count: static ' + stat.headers.length +
             ' vs render ' + model.headers.length);
      } else {
        model.headers.forEach(function (h, i) {
          if (norm(stat.headers[i]) !== norm(M.escapeHtml(h))) {
            fail('[' + which + '] header ' + (i + 1) + ': static ' +
                 JSON.stringify(norm(stat.headers[i])) + ' vs render ' + JSON.stringify(norm(h)));
          }
        });
      }
    }

    if (stat.rows.length !== model.rows.length) {
      fail('[' + which + '] row count: static ' + stat.rows.length +
           ' vs render ' + model.rows.length);
      continue;
    }

    model.rows.forEach(function (row, ri) {
      const sr = stat.rows[ri];
      const label = '[' + which + '] row ' + (ri + 1);

      if (sr.pending !== row.pending) {
        fail(label + ': static ' + (sr.pending ? 'has' : 'lacks') +
             ' class="row-pending", the data says it is ' +
             (row.pending ? 'pending' : 'measured'));
      }
      if (sr.cells.length !== row.cells.length) {
        fail(label + ': cell count static ' + sr.cells.length + ' vs render ' + row.cells.length);
        return;
      }
      row.cells.forEach(function (cell, ci) {
        const sc = sr.cells[ci];
        const wantTag = cell.scope === 'row' ? 'th' : 'td';
        if (sc.tag !== wantTag) {
          fail(label + ' cell ' + (ci + 1) + ': static is a <' + sc.tag + '>, render is a <' + wantTag + '>');
        }
        if (wantTag === 'th' && !/scope="row"/.test(sc.attrs)) {
          fail(label + ' cell ' + (ci + 1) + ': the static row header is missing scope="row"');
        }
        if (norm(sc.html) !== norm(cell.html)) {
          fail(label + ' cell ' + (ci + 1) + ': static ' + JSON.stringify(norm(sc.html)) +
               ' vs render ' + JSON.stringify(norm(cell.html)));
        }
      });
    });

    // The note under the table. A pending row renders a marker whose tooltip
    // sends the reader to a note under that same table, so the note has to be
    // there, and it has to be visible exactly when something is pending.
    const note = staticNotes[which];
    const wantNote = model.pendingCount > 0;
    const cfgBlock = which === 'storage' ? scenarios.storage_table
                   : which === 'engines' ? scenarios.engine_table
                   : scenarios.scenario_table;
    const noteText = cfgBlock && cfgBlock.pending_note;

    if (wantNote && !note) {
      fail('[' + which + '] ' + model.pendingCount + ' row(s) are pending but there is no ' +
           '[data-bench-note="' + which + '"] element for the marker to point at');
    } else if (wantNote && note) {
      if (note.hidden) fail('[' + which + '] the note is marked hidden while rows are still pending');
      if (!noteText) {
        fail('[' + which + '] rows are pending and the markup carries a note, but the JSON has no pending_note to fill it with');
      } else if (norm(note.html) !== norm(noteText)) {
        fail('[' + which + '] note text: static ' + JSON.stringify(norm(note.html)) +
             ' vs JSON ' + JSON.stringify(norm(noteText)));
      }
    } else if (!wantNote && note && !note.hidden) {
      fail('[' + which + '] nothing is pending but the static note is visible; the render would hide it');
    }
  }

  return findings;
}

module.exports = { check: check, norm: norm, decodeEntities: decodeEntities,
                   extractTables: extractTables, extractNotes: extractNotes };

if (require.main === module) {
  const findings = check();
  if (findings.length) {
    console.error('benchmarks drift: the static fallback and the JSON render disagree\n');
    findings.forEach(function (f) { console.error('  ' + f); });
    console.error('\n' + findings.length + ' drift(s). Fix benchmarks/index.html, benchmarks/data/*.json,');
    console.error('or benchmarks/js/scalability-tables.js so both copies say the same thing.');
    process.exit(1);
  }
  console.log('ok: the static fallback rows on /benchmarks/ match what the JSON renders');
  console.log('    (3 tables, every caption, header, cell, pending marker and note)');
}
