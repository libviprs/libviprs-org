(function () {
  'use strict';

  var TIP_ID = 'provenanceTooltip';
  var GUTTER_ID = 'genRustGutter';
  var ROWS_ID = 'genRustRows';

  // Cache the most recent prog so a late-loading gutter can still rebuild
  // (e.g. if cli.js fires update() before this script's DOM lookups would
  // succeed, or if a stylesheet swap re-creates the gutter element).
  var lastProg = null;

  // Module-scope tracker for the currently-active highlighted flag, so we can
  // implement toggle-off (re-click clears) and swap-without-flicker (clicking
  // a different flag's segment) behaviour.
  var activeHighlightFlag = null;

  function update(prog) {
    if (prog) lastProg = prog;
    var p = prog || lastProg;
    var gutter = document.getElementById(GUTTER_ID);
    if (!gutter || !p || !p.rustLines) return;

    // The row DOM is rebuilt on each render, but defensively tear down any
    // active highlight + the --hl-color custom property on the rows host.
    clearHighlight();

    gutter.style.gridTemplateRows =
      'repeat(' + p.rustLines.length + ', var(--gutter-line-h, 1.5em))';
    gutter.innerHTML = '';

    var flagColors = p.flagColors || {};
    (p.activeFlags || []).forEach(function (flag) {
      var segments = computeSegments(p.rustLines, flag);
      if (!segments.length) return;
      gutter.appendChild(
        buildColumn(flag, flagColors[flag], segments, p.rustLines.length)
      );
    });

    gutter.appendChild(buildTooltip());

    // Hide the tooltip when the mouse leaves the gutter as a whole, not
    // when leaving individual columns — this keeps the tooltip up while the
    // mouse moves between adjacent columns instead of flicker-hiding.
    gutter.addEventListener('mouseleave', function () {
      var t = gutter.querySelector('#' + TIP_ID);
      if (t) t.hidden = true;
    });

    // Tooltip follows the cursor while it's inside the gutter so it always
    // appears above the mouse pointer (rather than pinned to a column's
    // bounding box).
    gutter.addEventListener('mousemove', function (e) {
      var t = gutter.querySelector('#' + TIP_ID);
      if (!t || t.hidden) return;
      aimTooltipAt(t, e.clientX, e.clientY);
    });
  }

  // Position the tooltip just above (and centred on) the cursor. The CSS
  // `transform: translate(-50%, calc(-100% - 0.6rem))` does the visual
  // shift so this function only needs to set viewport-relative
  // top/left.
  function aimTooltipAt(tip, x, y) {
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function computeSegments(lines, flag) {
    var segments = [];
    var start = -1;
    var prev = -1;
    for (var i = 0; i < lines.length; i++) {
      var entry = lines[i];
      var owns = entry && entry.flags && entry.flags.indexOf(flag) !== -1;
      if (owns) {
        if (start === -1) {
          start = i;
        } else if (i !== prev + 1) {
          segments.push({ from: start + 1, to: prev + 1 });
          start = i;
        }
        prev = i;
      }
    }
    if (start !== -1) {
      segments.push({ from: start + 1, to: prev + 1 });
    }
    return segments;
  }

  function buildColumn(flag, color, segments, totalLines) {
    var col = document.createElement('div');
    col.className = 'gutter-col';
    col.setAttribute('data-flag', flag);
    if (color) col.style.setProperty('--flag-color', color);

    var lineCount = segments.reduce(function (acc, s) {
      return acc + (s.to - s.from + 1);
    }, 0);
    col.title =
      '--' + flag + ' (' + lineCount + ' line' + (lineCount === 1 ? '' : 's') + ')';

    // Each column is itself a CSS grid that mirrors the row template so that
    // bar-segments can use grid-row: <from> / <to + 1> directly.
    col.style.display = 'grid';
    col.style.gridTemplateRows =
      'repeat(' + totalLines + ', var(--gutter-line-h, 1.5em))';

    segments.forEach(function (seg) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bar-segment';
      btn.setAttribute('data-from-line', String(seg.from));
      btn.setAttribute('data-to-line', String(seg.to));
      btn.style.gridRow = seg.from + ' / ' + (seg.to + 1);
      var label =
        seg.from === seg.to
          ? 'Line ' + seg.from + ' added by --' + flag
          : 'Lines ' + seg.from + '–' + seg.to + ' added by --' + flag;
      btn.setAttribute('aria-label', label);
      col.appendChild(btn);
    });

    // Tooltip pops up immediately on column entry and follows the cursor
    // (mousemove handler in update()). We don't hide on column leave —
    // the gutter-level mouseleave handles that — so moving between
    // adjacent columns simply re-aims the tooltip's content without
    // flickering off and back on.
    col.addEventListener('mouseenter', function (e) {
      showTooltip(col, flag, lineCount, e);
    });

    // Click delegation for bar segments inside this column.
    col.addEventListener('click', function (e) {
      var seg = e.target.closest('.bar-segment');
      if (!seg) return;
      e.stopPropagation();
      var colEl = seg.closest('.gutter-col');
      if (!colEl) return;
      var clickedFlag = colEl.dataset.flag;
      if (!clickedFlag) return;
      if (activeHighlightFlag === clickedFlag) {
        // Re-click on the same flag: toggle off.
        clearHighlight();
      } else {
        // Different (or first) flag: swap directly. applyHighlight clears any
        // previously-highlighted rows in-place to avoid an intermediate flicker.
        var color = getComputedStyle(colEl).getPropertyValue('--flag-color').trim();
        applyHighlight(clickedFlag, color);
      }
    });

    return col;
  }

  // Tooltip is one shared element re-aimed and re-coloured per column.
  // Structured markup (icon + body) so CSS can colour the parts via the
  // flag's --tooltip-color custom property.
  function buildTooltip() {
    var tip = document.createElement('div');
    tip.className = 'provenance-tooltip';
    tip.id = TIP_ID;
    tip.hidden = true;
    tip.setAttribute('role', 'tooltip');

    var icon = document.createElement('span');
    icon.className = 'tooltip-icon';
    // FontAwesome 6 free "circle-info" mark.
    var fa = document.createElement('i');
    fa.className = 'fa-solid fa-circle-info';
    fa.setAttribute('aria-hidden', 'true');
    icon.appendChild(fa);

    var body = document.createElement('div');
    body.className = 'tooltip-body';
    var name = document.createElement('strong');
    name.className = 'tooltip-flag-name';
    var meta = document.createElement('span');
    meta.className = 'tooltip-meta';
    body.appendChild(name);
    body.appendChild(meta);

    tip.appendChild(icon);
    tip.appendChild(body);
    return tip;
  }

  function showTooltip(col, flag, lineCount, mouseEvent) {
    var gutter = col.parentNode;
    if (!gutter) return;
    var tip = gutter.querySelector('#' + TIP_ID);
    if (!tip) return;

    var name = tip.querySelector('.tooltip-flag-name');
    var meta = tip.querySelector('.tooltip-meta');
    if (name) name.textContent = '--' + flag;
    if (meta)
      meta.textContent = lineCount + ' line' + (lineCount === 1 ? '' : 's');

    // Colour the tooltip from the column's --flag-color.
    var color = getComputedStyle(col).getPropertyValue('--flag-color').trim();
    if (color) tip.style.setProperty('--tooltip-color', color);

    tip.hidden = false;

    // Aim at the cursor on first reveal so the tooltip never flashes
    // somewhere irrelevant before the gutter-level mousemove handler
    // catches up. If the mouseenter event isn't available (e.g.
    // synthesized hover on touch), fall back to the column's centre.
    if (mouseEvent && typeof mouseEvent.clientX === 'number') {
      aimTooltipAt(tip, mouseEvent.clientX, mouseEvent.clientY);
    } else {
      var cRect = col.getBoundingClientRect();
      aimTooltipAt(tip, cRect.left + cRect.width / 2, cRect.top + 6);
    }
  }

  // Add `.is-highlighted` to every `.code-row` whose source line owns `flag`.
  // Sets `--hl-color` on `#genRustRows` so the CSS rule
  //   .code-row.is-highlighted { background: color-mix(in srgb, var(--hl-color) 20%, transparent); }
  // (or any equivalent low-opacity rule) picks up the right colour.
  // Performs an in-place swap (clear-then-set) so re-targeting between flags
  // doesn't flash an unhighlighted intermediate state.
  function applyHighlight(flag, color) {
    var rows = document.getElementById(ROWS_ID);
    if (!rows || !lastProg || !lastProg.rustLines) return;

    // Clear any rows currently highlighted from a previous flag.
    var prev = rows.querySelectorAll('.code-row.is-highlighted');
    for (var j = 0; j < prev.length; j++) {
      prev[j].classList.remove('is-highlighted');
    }

    var lines = lastProg.rustLines;
    for (var i = 0; i < lines.length; i++) {
      var entry = lines[i];
      if (entry && entry.flags && entry.flags.indexOf(flag) !== -1) {
        var row = document.querySelector(
          '.code-row[data-line="' + (i + 1) + '"]'
        );
        if (row) row.classList.add('is-highlighted');
      }
    }

    if (color) {
      rows.style.setProperty('--hl-color', color);
    } else {
      rows.style.removeProperty('--hl-color');
    }
    activeHighlightFlag = flag;
  }

  function clearHighlight() {
    var rows = document.getElementById(ROWS_ID);
    if (rows) {
      var hi = rows.querySelectorAll('.code-row.is-highlighted');
      for (var i = 0; i < hi.length; i++) {
        hi[i].classList.remove('is-highlighted');
      }
      rows.style.removeProperty('--hl-color');
    }
    activeHighlightFlag = null;
  }

  // Click outside any code row or gutter bar segment clears the highlight.
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    if (e.target.closest('.bar-segment')) return; // handled by column listener
    if (e.target.closest('.code-row')) return; // clicks inside code preserve state
    if (activeHighlightFlag !== null) clearHighlight();
  });

  // If the DOM is still loading and cli.js has already pushed a prog before
  // the gutter element existed, retry once when DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (lastProg) update(lastProg);
    });
  }

  window.CodeGutter = { update: update };
})();
