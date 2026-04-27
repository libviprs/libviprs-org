/* Renders the two data tables on /benchmarks/ from JSON.
 *
 * Sources (paths resolved relative to this script's own location, so
 * the page works whether served from /, /benchmarks/, or any sub-path):
 *   ../data/scalability_results.json — raw bench output. libviprs-bench
 *     produces this alongside the SVGs; copy both to benchmarks/data
 *     and benchmarks/img on each republish.
 *   ../data/engine-scenarios.json — editorial copy: display labels,
 *     captions, scenario picker rows, speed-cell templates.
 *
 * Targets in the HTML are tagged with `data-bench-table="engines"`
 * and `data-bench-table="scenarios"` on their <table> elements so
 * the existing static rows can stand as graceful fallback if the
 * fetch fails (e.g. file:// preview, network error, JS off).
 *
 * Speed-template substitution: for scenarios whose `engine_id`
 * matches a row in scalability_results.json, the placeholders
 * `{throughput}`, `{mp}`, `{memory}` are replaced with that
 * engine's metrics at the largest tested megapixel point. For
 * engine_id values that don't appear in the bench data (e.g.
 * "auto"), the template is rendered verbatim.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Number formatting
  // ---------------------------------------------------------------------------

  function fmt(value, spec) {
    if (value == null || Number.isNaN(value)) return '—';
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

  function largestMpRow(rows, engineId) {
    let best = null;
    for (const r of rows) {
      if (r.engine !== engineId) continue;
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

  function findRow(rows, engineId, mp) {
    for (const r of rows) {
      if (r.engine === engineId && r.megapixels === mp) return r;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Engine-comparison table renderer
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

  function renderEngineTable(table, results, scenariosCfg, showcaseMp) {
    const cfg = scenariosCfg.engine_table;
    const display = scenariosCfg.engine_display;
    if (!cfg || !display || showcaseMp == null) return;
    const sample = results.find(function (r) { return r.megapixels === showcaseMp; });

    // Caption — substitute width / height / mp from the showcase row.
    const captionEl = table.querySelector('caption');
    if (captionEl && cfg.caption_template && sample) {
      captionEl.textContent = cfg.caption_template
        .replace('{width}',  sample.width)
        .replace('{height}', sample.height)
        .replace('{mp}',     showcaseMp.toFixed(showcaseMp >= 100 ? 0 : 1));
    }

    // Header — first cell is the engine label column.
    const thead = table.querySelector('thead tr');
    if (thead) {
      thead.innerHTML =
        '<th scope="col">Engine</th>' +
        cfg.columns.map(function (c) {
          return '<th scope="col">' + escapeHtml(c.header) + '</th>';
        }).join('');
    }

    // Body — one row per engine in the configured order.
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    const rows = cfg.engine_order.map(function (engineId) {
      const display_ = display[engineId];
      if (!display_) return '';
      const row = findRow(results, engineId, showcaseMp);
      const cells = cfg.columns.map(function (c) {
        const val = row ? row[c.key] : null;
        return '<td>' + fmt(val, c) + '</td>';
      }).join('');
      return (
        '<tr>' +
          '<th scope="row">' +
            '<span class="engine-cell">' +
              '<span class="engine-swatch swatch-' + escapeHtml(display_.swatch) + '"></span>' +
              escapeHtml(display_.label) +
            '</span>' +
          '</th>' +
          cells +
        '</tr>'
      );
    }).join('');
    tbody.innerHTML = rows;
  }

  // ---------------------------------------------------------------------------
  // Scenario-picker table renderer
  // ---------------------------------------------------------------------------

  function fillSpeedTemplate(template, engineRow) {
    if (!engineRow) return template;
    const throughput = Math.round(engineRow.tiles_per_second).toLocaleString('en-US');
    const mp = engineRow.megapixels.toFixed(engineRow.megapixels >= 100 ? 0 : 1);
    const memory = Math.round(engineRow.peak_memory_mb).toLocaleString('en-US');
    return template
      .replace(/\{throughput\}/g, throughput)
      .replace(/\{mp\}/g,         mp)
      .replace(/\{memory\}/g,     memory);
  }

  function renderScenarioTable(table, results, scenariosCfg, showcaseMp) {
    const cfg = scenariosCfg.scenario_table;
    const display = scenariosCfg.engine_display;
    if (!cfg || !display) return;

    const captionEl = table.querySelector('caption');
    if (captionEl && cfg.caption) captionEl.textContent = cfg.caption;

    const thead = table.querySelector('thead tr');
    if (thead && cfg.headers) {
      thead.innerHTML = cfg.headers.map(function (h) {
        return '<th scope="col">' + escapeHtml(h) + '</th>';
      }).join('');
    }

    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    tbody.innerHTML = cfg.scenarios.map(function (s) {
      const eng = display[s.engine_id] || { label: s.engine_id, swatch: '' };
      // Prefer the engine's row at the engine-table's showcase MP so
      // both tables read off the same showcase numbers; fall back to
      // its largest-MP row if the showcase doesn't exist for this
      // engine (e.g. partial bench data).
      const benchRow = (showcaseMp != null && findRow(results, s.engine_id, showcaseMp))
        || largestMpRow(results, s.engine_id);
      const speedHtml = fillSpeedTemplate(s.speed_template || '', benchRow);
      return (
        '<tr>' +
          '<th scope="row">' + escapeHtml(s.scenario) + '</th>' +
          '<td>' +
            '<span class="engine-cell">' +
              '<span class="engine-swatch swatch-' + escapeHtml(eng.swatch) + '"></span>' +
              escapeHtml(eng.label) +
            '</span>' +
          '</td>' +
          // memory_complexity, speed, best_when carry curated inline
          // tags (<code>) so they pass through un-escaped.
          '<td>' + (s.memory_complexity || '') + '</td>' +
          '<td>' + speedHtml + '</td>' +
          '<td>' + (s.best_when || '') + '</td>' +
        '</tr>'
      );
    }).join('');
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
    ]).then(function (parts) {
      const results = parts[0];
      const cfg = parts[1];
      const target = cfg.engine_table && cfg.engine_table.showcase_mp_target;
      const showcaseMp = pickShowcaseMp(results, target);
      document.querySelectorAll('table[data-bench-table]').forEach(function (table) {
        const which = table.dataset.benchTable;
        try {
          if (which === 'engines') {
            renderEngineTable(table, results, cfg, showcaseMp);
          } else if (which === 'scenarios') {
            renderScenarioTable(table, results, cfg, showcaseMp);
          }
        } catch (e) {
          // Leave the static fallback rows in place if anything throws.
          console.warn('[bench-table] render failed for', which, e);
        }
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
