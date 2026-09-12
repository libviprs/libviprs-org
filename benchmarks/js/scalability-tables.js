/* Renders the three data tables on /benchmarks/ from JSON.
 *
 * Sources (paths resolved relative to this script's own location, so
 * the page works whether served from /, /benchmarks/, or any sub-path):
 *   ../data/scalability_results.json — raw engine-bench output. libviprs-bench
 *     produces this alongside the SVGs; copy both to benchmarks/data
 *     and benchmarks/img on each republish. It is a generated artifact and
 *     nothing in this repo may hand-edit a row into it: the next republish
 *     overwrites the file wholesale, and its producer declares several of
 *     these fields as bare non-optional numbers, so a hand-written null
 *     stops the file round-tripping through the tooling that owns it.
 *   ../data/pmtiles_results.json — raw storage-bench output, a different
 *     harness with a different grid. Envelope: {"schema": N, "rows": [...]}.
 *     This renderer reads schema 1 and refuses anything else rather than
 *     guessing at a shape it does not know.
 *   ../data/engine-scenarios.json — editorial copy: display labels, captions,
 *     column specs, scenario picker rows, speed-cell templates.
 *
 * Targets in the HTML are tagged with `data-bench-table="engines"`,
 * `"scenarios"` and `"storage"` on their <table> elements so the existing
 * static rows can stand as graceful fallback if a fetch fails (file://
 * preview, network error, JS off).
 *
 * Storage is an axis crossed with the engines, not a fifth engine, so it
 * lives in its own table fed by its own export. That table carries the
 * columns the engine comparison has no home for: bytes on disk, filesystem
 * entries, and per-lookup read latency.
 *
 * Speed-template substitution: for scenarios whose `engine_id` matches a row
 * in scalability_results.json, the placeholders `{throughput}`, `{mp}`,
 * `{memory}` are replaced with that engine's metrics at the largest tested
 * megapixel point. For engine_id values that don't appear in the bench data
 * (e.g. "auto"), the template is rendered verbatim.
 *
 * Pending cells: there is no pending flag in any of the data and this file
 * reads none. A metric is pending when its value is null, and that is the
 * whole signal. fmt() prints the same em dash an absent metric already used,
 * a row with ANY null metric cell is marked pending per row, that row's label
 * picks up `pending_marker`, and the [data-bench-note] paragraph under that
 * same table is filled from `pending_note` and un-hidden. Any rather than
 * every, deliberately: a row missing one column and marked is a visible,
 * self-correcting over-reaction, while a row missing one column and unmarked
 * is a silent em dash on a public page with nothing explaining it.
 * Filling the nulls clears all three with no edit here or in
 * engine-scenarios.json. It does NOT update the static fallback rows in
 * index.html, which are the JS-off copy of the same cells and drift silently:
 * benchmarks/tools/bench-drift.js is the gate that catches that, and it reads
 * the models below rather than a second copy of this formatting.
 *
 * This file is a classic <script defer>, and it is also require()-able from
 * Node so that gate can call the model builders directly. Everything below
 * the model builders is DOM work and only runs when there is a document.
 */
(function () {
  'use strict';

  // The only pmtiles_results.json envelope this page knows how to read.
  const PMTILES_SCHEMA = 1;

  // ---------------------------------------------------------------------------
  // Number formatting
  // ---------------------------------------------------------------------------

  function fmt(value, spec) {
    if (value == null || Number.isNaN(value)) return '—';
    // Some columns (e.g. an engine's own working set) carry a real 0 for
    // engines the bench doesn't instrument that way — libvips reports no
    // tracked working set. Render those as an em-dash rather than "0",
    // which would falsely read as "uses no memory".
    if (spec && spec.zero_as_dash && value === 0) return '—';
    // `scale` divides before formatting, for columns the producer emits in
    // one unit and the table prints in another (bytes exported, MB shown).
    if (spec && spec.scale) value = value / spec.scale;
    const f = (spec && spec.format) || 'auto';
    let n;
    switch (f) {
      case 'int':
        n = Math.round(value);
        break;
      case 'fixed1':
        return value.toFixed(1);
      case 'fixed2':
        return value.toFixed(2);
      case 'fixed3':
        return value.toFixed(3);
      default:
        n = value;
    }
    if (spec && spec.thousands) {
      return Number(n).toLocaleString('en-US');
    }
    return String(n);
  }

  // Best-effort HTML escape for editorial fields. The scenario JSON is
  // hand-curated and may contain inline tags like <code>; we trust
  // those. Cells flagged as plain text get escaped.
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return c === '&' ? '&amp;' :
             c === '<' ? '&lt;'  :
             c === '>' ? '&gt;'  :
             c === '"' ? '&quot;': '&#39;';
    });
  }

  // ---------------------------------------------------------------------------
  // Bench-data helpers
  // ---------------------------------------------------------------------------

  // A row is only usable for a number if it actually carries one. A row with
  // the right identity (size, engine, tile count) and null measurements must
  // never reach a formatter that would turn the absence into a value.
  // Math.round(null) is 0, which would print "0 tiles/s" and read as a
  // measured result.
  function hasMetrics(row) {
    return !!row && row.tiles_per_second != null;
  }

  function largestMpRow(rows, engineId) {
    let best = null;
    for (const r of rows) {
      if (r.engine !== engineId) continue;
      if (!hasMetrics(r)) continue;
      if (!best || r.megapixels > best.megapixels) best = r;
    }
    return best;
  }

  function uniqueDescendingMps(rows) {
    const seen = new Set();
    return rows
      .map(function (r) { return r.megapixels; })
      .filter(function (mp) {
        if (seen.has(mp)) return false;
        seen.add(mp);
        return true;
      })
      .sort(function (a, b) { return b - a; });
  }

  // scalability_results.json carries exactly one row per (engine, megapixels)
  // within the concurrency series the caller already filtered to, so a first
  // match is the only match.
  function findRow(rows, engineId, mp) {
    for (const r of rows) {
      if (r.engine === engineId && r.megapixels === mp) return r;
    }
    return null;
  }

  // Read a metric off a bench row, tolerating the v0.4.0 schema rename of
  // the memory column: the peak-memory field is now `peak_rss_mb` (process
  // RSS), where older exports used `peak_memory_mb`. A column keyed on
  // either name resolves to the RSS field when present and falls back to
  // the legacy field so pre-v0.4.0 JSON still renders.
  function readMetric(row, key) {
    if (!row) return null;
    if (key === 'peak_rss_mb' || key === 'peak_memory_mb') {
      return row.peak_rss_mb != null ? row.peak_rss_mb : row.peak_memory_mb;
    }
    return row[key];
  }

  // ---------------------------------------------------------------------------
  // Storage-data helpers
  // ---------------------------------------------------------------------------

  // Unwrap the storage export, refusing a shape this page does not understand
  // instead of rendering it. A bare array is the pre-envelope shape and is
  // refused for the same reason: it carries no version to check.
  function readStorageRows(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('pmtiles_results.json: expected a {schema, rows} envelope');
    }
    if (doc.schema !== PMTILES_SCHEMA) {
      throw new Error(
        'pmtiles_results.json: schema ' + JSON.stringify(doc.schema) +
        ', this page reads ' + PMTILES_SCHEMA);
    }
    if (!Array.isArray(doc.rows)) {
      throw new Error('pmtiles_results.json: `rows` is not an array');
    }
    return doc.rows;
  }

  // The storage export is NOT unique on (engine, megapixels): one pyramid
  // carries a generation row and several read rows, all at the same size, and
  // `engine` is the compute engine rather than the backend. So the key is the
  // full identity, and an ambiguous match returns nothing rather than the
  // first hit — publishing a read row's wall time in a generation column is
  // precisely the failure this is guarding against.
  function findStorageRow(rows, sel) {
    // A column here is identified by (key, scenario) and never by key alone:
    // the cold read and the random read both report p50_latency_us. A caller
    // that omits the scenario is reaching for a shortcut that cannot name one
    // column, so this fails loudly instead of returning the first plausible
    // row or a quiet null that reads like "not measured".
    if (!sel || !sel.scenario) {
      throw new Error(
        'findStorageRow needs a `scenario`: rows are not unique on ' +
        '(storage, size, tile_size) alone, and more than one column can share a key');
    }
    let found = null;
    for (const r of rows) {
      if (r.storage !== sel.storage) continue;
      if (r.width !== sel.width || r.height !== sel.height) continue;
      if (r.tile_size !== sel.tile_size) continue;
      if (r.scenario !== sel.scenario) continue;
      if (sel.concurrency != null && r.concurrency !== sel.concurrency) continue;
      if (found) return null;
      found = r;
    }
    return found;
  }

  // ---------------------------------------------------------------------------
  // Cell fragments shared by every table
  // ---------------------------------------------------------------------------

  // A coloured dot plus a label, optionally carrying the pending marker.
  // `marker` is already decided by the caller: it is empty whenever the table
  // has no note element for it to point at, so the page can never render a
  // marker whose tooltip promises a footnote that does not exist.
  function swatchCellHtml(display, marker, noteLabel) {
    const label = escapeHtml(display.label);
    const dot = '<span class="engine-swatch swatch-' + escapeHtml(display.swatch) + '"></span>';
    const sup = marker
      ? '<sup class="bench-pending" title="Some measurements are missing; see the note under ' +
        escapeHtml(noteLabel) + '.">' + escapeHtml(marker) + '</sup>'
      : '';
    return '<span class="engine-cell">' + dot + label + sup + '</span>';
  }

  function markerFor(cfg, hasNote, pending) {
    if (!pending || !hasNote) return '';
    return cfg.pending_marker || '';
  }

  // ---------------------------------------------------------------------------
  // Table models — pure, no DOM. The renderers below and the drift gate in
  // benchmarks/tools/bench-drift.js both read these, so the gate compares the
  // static fallback against the real formatting rather than a second copy of
  // it.
  // ---------------------------------------------------------------------------

  // Pick the showcase image size: prefer the bench row closest to the
  // configured target (anchors the tables to the size the surrounding
  // prose discusses) and fall back to the largest tested size if no
  // target is configured.
  function pickShowcaseMp(results, target) {
    const allMp = uniqueDescendingMps(results);
    if (allMp.length === 0) return null;
    if (typeof target !== 'number') return allMp[0];
    return allMp.reduce(function (best, mp) {
      return Math.abs(mp - target) < Math.abs(best - target) ? mp : best;
    }, allMp[0]);
  }

  // The engine bench exports a single-thread (concurrency 1) and a 10-thread
  // series. The article's figures, prose and tables all report the
  // single-thread series, so filter to it — otherwise every size would carry
  // two rows and findRow/showcase selection would pick arbitrarily. Rows with
  // no `concurrency` field (pre-v0.4.0 exports) are kept as-is.
  function singleThread(rows) {
    return rows.filter(function (r) {
      return r.concurrency == null || r.concurrency === 1;
    });
  }

  function engineTableModel(results, scenariosCfg, showcaseMp) {
    const cfg = scenariosCfg.engine_table;
    const display = scenariosCfg.engine_display;
    if (!cfg || !display || showcaseMp == null) return null;
    const sample = results.find(function (r) { return r.megapixels === showcaseMp; });

    let caption = null;
    if (cfg.caption_template && sample) {
      caption = cfg.caption_template
        .replace('{width}',  sample.width)
        .replace('{height}', sample.height)
        .replace('{mp}',     showcaseMp.toFixed(showcaseMp >= 100 ? 0 : 1));
    }

    const headers = ['Engine'].concat(cfg.columns.map(function (c) { return c.header; }));

    const rows = cfg.engine_order.map(function (engineId) {
      const display_ = display[engineId];
      if (!display_) return null;
      const row = findRow(results, engineId, showcaseMp);
      const cells = cfg.columns.map(function (c) {
        return { html: fmt(readMetric(row, c.key), c) };
      });
      // The engine table has no note element and no pending rows: every
      // engine in engine_order is measured by the same sweep that produced
      // the file. A missing row renders as em dashes without a marker.
      return {
        pending: false,
        cells: [{ scope: 'row', html: swatchCellHtml(display_, '', '') }].concat(cells),
      };
    }).filter(Boolean);

    return { caption: caption, headers: headers, rows: rows, pendingCount: 0 };
  }

  function fillSpeedTemplate(template, engineRow) {
    // No row, or a row whose measurements are still pending, means there is
    // nothing to substitute. Render the template as written.
    if (!hasMetrics(engineRow)) return template;
    const throughput = Math.round(engineRow.tiles_per_second).toLocaleString('en-US');
    const mp = engineRow.megapixels.toFixed(engineRow.megapixels >= 100 ? 0 : 1);
    // {memory} is the engine's working set — the constant-memory "envelope"
    // the streaming/MapReduce scenarios talk about (tracked_memory_mb), not
    // whole-process RSS. Fall back to RSS, then to the legacy field.
    const memBasis = engineRow.tracked_memory_mb != null ? engineRow.tracked_memory_mb
      : (engineRow.peak_rss_mb != null ? engineRow.peak_rss_mb : engineRow.peak_memory_mb);
    const memory = Math.round(memBasis).toLocaleString('en-US');
    return template
      .replace(/\{throughput\}/g, throughput)
      .replace(/\{mp\}/g,         mp)
      .replace(/\{memory\}/g,     memory);
  }

  function scenarioTableModel(results, scenariosCfg, showcaseMp) {
    const cfg = scenariosCfg.scenario_table;
    const display = scenariosCfg.engine_display;
    if (!cfg || !display) return null;

    const rows = cfg.scenarios.map(function (s) {
      const eng = display[s.engine_id] || { label: s.engine_id, swatch: '' };
      // Prefer the engine's row at the engine-table's showcase MP so both
      // tables read off the same showcase numbers; fall back to its
      // largest-MP row if the showcase doesn't exist for this engine.
      const benchRow = (showcaseMp != null && findRow(results, s.engine_id, showcaseMp))
        || largestMpRow(results, s.engine_id);
      return {
        pending: false,
        cells: [
          { scope: 'row', html: escapeHtml(s.scenario) },
          { html: swatchCellHtml(eng, '', '') },
          // memory_complexity, speed and best_when carry curated inline
          // tags (<code>, <a>) so they pass through un-escaped.
          { html: s.memory_complexity || '' },
          { html: fillSpeedTemplate(s.speed_template || '', benchRow) },
          { html: s.best_when || '' },
        ],
      };
    });

    return {
      caption: cfg.caption || null,
      headers: cfg.headers || null,
      rows: rows,
      pendingCount: 0,
    };
  }

  function storageTableModel(storageRows, scenariosCfg, hasNote) {
    const cfg = scenariosCfg.storage_table;
    if (!cfg || !Array.isArray(cfg.rows) || !Array.isArray(cfg.columns)) return null;
    const display = cfg.storage_display || {};

    // Same rule as findStorageRow, enforced where columns are declared rather
    // than where they are read, so a column added without a scenario fails at
    // the first render instead of silently resolving to nothing.
    cfg.columns.forEach(function (c, i) {
      if (!c || !c.scenario) {
        throw new Error(
          'storage_table.columns[' + i + '] (' + (c && c.key) + ') has no `scenario`. ' +
          'Columns are identified by (key, scenario); p50_latency_us already names two of them.');
      }
    });

    const headers = ['Pyramid', 'Storage']
      .concat(cfg.columns.map(function (c) { return c.header; }));

    let pendingCount = 0;
    const rows = cfg.rows.map(function (spec) {
      const cells = cfg.columns.map(function (c) {
        // Each column names the scenario it reads, so a generation column can
        // never pick up a read row and vice versa.
        const row = findStorageRow(storageRows, {
          storage: spec.storage,
          width: spec.width,
          height: spec.height,
          tile_size: spec.tile_size,
          scenario: c.scenario,
          concurrency: c.concurrency,
        });
        const val = row ? row[c.key] : null;
        // `absent` is read off the value, not off the rendered em dash: a
        // column carrying zero_as_dash renders a real 0 as an em dash too, and
        // that is a measurement, not a hole.
        return { html: fmt(val == null ? null : val, c), absent: val == null };
      });
      // ANY absent cell marks the row, not every one. The two failure modes
      // are not symmetric. Marking too eagerly puts a visible flag on a row
      // that is mostly measured, which corrects itself the moment the data
      // lands. Marking too rarely publishes silent em dashes with no marker
      // and no note, which is absence that does not announce itself, and that
      // is the whole thing this page has been built not to do.
      const pending = cells.some(function (cell) { return cell.absent; });
      if (pending) pendingCount += 1;

      const label = (cfg.row_label_template || '{width}×{height}')
        .replace('{width}',     String(spec.width))
        .replace('{height}',    String(spec.height))
        .replace('{tile_size}', String(spec.tile_size));
      const disp = display[spec.storage] || { label: spec.storage, swatch: '' };
      const marker = markerFor(cfg, hasNote, pending);

      return {
        pending: pending,
        cells: [
          { scope: 'row', html: escapeHtml(label) },
          { html: swatchCellHtml(disp, marker, 'this table') },
        ].concat(cells),
      };
    });

    return {
      caption: cfg.caption || null,
      headers: headers,
      rows: rows,
      pendingCount: pendingCount,
    };
  }

  const MODELS = {
    PMTILES_SCHEMA: PMTILES_SCHEMA,
    fmt: fmt,
    escapeHtml: escapeHtml,
    readStorageRows: readStorageRows,
    findStorageRow: findStorageRow,
    pickShowcaseMp: pickShowcaseMp,
    singleThread: singleThread,
    engineTableModel: engineTableModel,
    scenarioTableModel: scenarioTableModel,
    storageTableModel: storageTableModel,
  };

  // Requireable from Node for the drift gate. Harmless in a browser, where
  // `module` is undefined.
  if (typeof module === 'object' && module && module.exports) {
    module.exports = MODELS;
  }

  // Everything past here is DOM work.
  if (typeof document === 'undefined') return;

  // ---------------------------------------------------------------------------
  // Painting a model into a table
  // ---------------------------------------------------------------------------

  function paint(table, model) {
    if (!model) return 0;

    const captionEl = table.querySelector('caption');
    if (captionEl && model.caption) captionEl.textContent = model.caption;

    const thead = table.querySelector('thead tr');
    if (thead && model.headers) {
      thead.innerHTML = model.headers.map(function (h) {
        return '<th scope="col">' + escapeHtml(h) + '</th>';
      }).join('');
    }

    const tbody = table.querySelector('tbody');
    if (!tbody) return 0;
    tbody.innerHTML = model.rows.map(function (r) {
      const cells = r.cells.map(function (c) {
        return c.scope === 'row'
          ? '<th scope="row">' + c.html + '</th>'
          : '<td>' + c.html + '</td>';
      }).join('');
      return '<tr' + (r.pending ? ' class="row-pending"' : '') + '>' + cells + '</tr>';
    }).join('');
    return model.pendingCount || 0;
  }

  function noteElement(which) {
    return document.querySelector('[data-bench-note="' + which + '"]');
  }

  // Fill and reveal the note under a table, or hide it, depending on whether
  // anything pending was actually rendered into that table.
  function updatePendingNote(which, noteHtml, pendingCount) {
    const el = noteElement(which);
    if (!el) return;
    if (pendingCount > 0 && noteHtml) {
      // innerHTML on purpose, and the one place on this page that assigns
      // markup rather than escaping it. The note is a repo-controlled string
      // in engine-scenarios.json and it legitimately carries a <code> and a
      // link, so it is markup by design. It sits next to data files a test
      // harness generates, so: if a note string ever starts coming from
      // anywhere but this repo's own editorial JSON, escape it, or the next
      // person to move a string across that boundary gets stored XSS for free.
      el.innerHTML = noteHtml;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  // ---------------------------------------------------------------------------
  // First-column auto-sizing
  // ---------------------------------------------------------------------------

  /* Default sizing rule: shrink the first column to the natural single-line
   * width of its widest cell. If that natural width would exceed
   *   threshold_ratio × (the other-column width that results from giving
   *   the rest of the table the remaining space)
   * the column is capped at
   *   cap_ratio × that other-column width
   * and its cells are allowed to wrap. Override per-table by placing a
   * `column_sizing` block in the table's JSON config — anything you set
   * there is merged on top of the JSON's `default_column_sizing` object,
   * which itself is merged on top of these constants. */
  const HARD_DEFAULT_COL_SIZING = {
    threshold_ratio: 2.0,
    cap_ratio: 1.75,
  };

  function resolveColSizing(scenariosCfg, perTable) {
    return Object.assign(
      {},
      HARD_DEFAULT_COL_SIZING,
      scenariosCfg.default_column_sizing || {},
      perTable || {}
    );
  }

  function sizeFirstColumn(table, sizing) {
    if (!table || !table.tBodies || !table.tBodies.length) return;
    const firstCells = Array.from(table.querySelectorAll(
      ':scope > thead > tr > th:first-child, ' +
      ':scope > tbody > tr > th:first-child, ' +
      ':scope > tfoot > tr > th:first-child'
    ));
    if (firstCells.length === 0) return;

    // Snapshot the inline styles we're about to mutate so we can put
    // everything back afterwards.
    const orig = firstCells.map(function (c) {
      return { ws: c.style.whiteSpace, w: c.style.width, ovr: c.style.overflow };
    });
    const origLayout = table.style.tableLayout;

    // Switch to auto layout + nowrap so each cell sizes to its content,
    // measure, then restore the fixed layout. Reading offsetWidth forces
    // the reflow so the measurement is current.
    table.style.tableLayout = 'auto';
    firstCells.forEach(function (c) {
      c.style.whiteSpace = 'nowrap';
      c.style.width = 'max-content';
      c.style.overflow = 'visible';
    });
    void table.offsetWidth;
    const naturalCw = firstCells.reduce(function (m, c) {
      return Math.max(m, c.offsetWidth);
    }, 0);

    // Restore.
    table.style.tableLayout = origLayout;
    firstCells.forEach(function (c, i) {
      c.style.whiteSpace = orig[i].ws;
      c.style.width      = orig[i].w;
      c.style.overflow   = orig[i].ovr;
    });
    void table.offsetWidth;

    const tableW = table.offsetWidth;
    const headerCells = table.querySelectorAll(':scope > thead > tr > *');
    const otherCount = Math.max(0, headerCells.length - 1);
    if (tableW === 0 || otherCount === 0) return;

    // Algebra: with the first column at width `cw` and the remaining
    // columns evenly sharing (tableW - cw) across `otherCount` slots,
    // the per-other-column width is (tableW - cw) / otherCount. Asking
    // `cw / otherCol > threshold_ratio` is equivalent to
    //   cw > threshold_ratio · tableW / (otherCount + threshold_ratio).
    // Same algebra produces the cap.
    const t = sizing.threshold_ratio;
    const c = sizing.cap_ratio;
    const threshold = (t * tableW) / (otherCount + t);
    let firstColW;
    let allowWrap;
    if (naturalCw > threshold) {
      firstColW = (c * tableW) / (otherCount + c);
      allowWrap = true;
    } else {
      firstColW = naturalCw;
      allowWrap = false;
    }

    firstCells.forEach(function (cell) {
      cell.style.width = firstColW + 'px';
      cell.style.whiteSpace = allowWrap ? 'normal' : 'nowrap';
    });
  }

  function perTableSizing(cfg, which) {
    const block = which === 'engines'   ? cfg.engine_table
                : which === 'scenarios' ? cfg.scenario_table
                : which === 'storage'   ? cfg.storage_table
                : null;
    return (block && block.column_sizing) || null;
  }

  function sizeAllFirstColumns(cfg) {
    document.querySelectorAll('table[data-bench-table]').forEach(function (table) {
      const which = table.dataset.benchTable;
      try {
        sizeFirstColumn(table, resolveColSizing(cfg, perTableSizing(cfg, which)));
      } catch (e) {
        console.warn('[bench-table] sizing failed for', which, e);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  // Resolve fetch URLs relative to this script's own location so the
  // page works regardless of where it's mounted. The data lives at
  // ../data/ relative to the script (benchmarks/js/ → benchmarks/data/).
  // document.currentScript is set while the script body is executing
  // synchronously — `defer` keeps that intact for classic scripts.
  function dataDir() {
    const cur = document.currentScript;
    const fallback = '../data/';
    if (!cur || !cur.src) return fallback;
    const here = cur.src.substring(0, cur.src.lastIndexOf('/') + 1);
    // Resolve `here + ../data/` via URL so it normalises correctly.
    try { return new URL('../data/', here).href; }
    catch (_) { return fallback; }
  }
  const baseDir = dataDir();

  function fetchJson(name) {
    return fetch(baseDir + name, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('fetch ' + name + ' → HTTP ' + r.status);
      return r.json();
    });
  }

  function init() {
    Promise.all([
      fetchJson('scalability_results.json'),
      fetchJson('engine-scenarios.json'),
      // A storage export that is missing, unreadable or of an unknown schema
      // leaves the storage table's static fallback standing, the same way a
      // failed engine fetch does. It must not take the other two tables down.
      fetchJson('pmtiles_results.json').then(readStorageRows).catch(function (e) {
        console.warn('[bench-table] storage data unavailable; static fallback rows remain', e);
        return null;
      }),
    ]).then(function (parts) {
      const results = singleThread(parts[0]);
      const cfg = parts[1];
      const storageRows = parts[2];
      const target = cfg.engine_table && cfg.engine_table.showcase_mp_target;
      const showcaseMp = pickShowcaseMp(results, target);

      document.querySelectorAll('table[data-bench-table]').forEach(function (table) {
        const which = table.dataset.benchTable;
        try {
          let pending = 0;
          let noteHtml = null;
          if (which === 'engines') {
            pending = paint(table, engineTableModel(results, cfg, showcaseMp));
          } else if (which === 'scenarios') {
            pending = paint(table, scenarioTableModel(results, cfg, showcaseMp));
          } else if (which === 'storage') {
            if (storageRows == null) return;
            const model = storageTableModel(storageRows, cfg, !!noteElement('storage'));
            pending = paint(table, model);
            noteHtml = cfg.storage_table && cfg.storage_table.pending_note;
          }
          // Only touch the note once its table rendered. If the render threw,
          // the static fallback rows stand and so must the static note that
          // goes with them.
          updatePendingNote(which, noteHtml, pending || 0);
        } catch (e) {
          // Leave the static fallback rows in place if anything throws.
          console.warn('[bench-table] render failed for', which, e);
        }
      });

      // Size the first column once on initial render, then again on
      // viewport resize (debounced). The natural width depends on the
      // current font size, which the mobile media query may change.
      sizeAllFirstColumns(cfg);
      let resizeTimer = null;
      window.addEventListener('resize', function () {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () { sizeAllFirstColumns(cfg); }, 150);
      });
    }).catch(function (e) {
      console.warn('[bench-table] data load failed; static fallback rows remain', e);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
