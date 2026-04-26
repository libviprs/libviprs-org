(function () {
  'use strict';

  var TIP_ID = 'provenanceTooltip';
  var GUTTER_ID = 'genRustGutter';

  // Cache the most recent prog so a late-loading gutter can still rebuild
  // (e.g. if cli.js fires update() before this script's DOM lookups would
  // succeed, or if a stylesheet swap re-creates the gutter element).
  var lastProg = null;

  function update(prog) {
    if (prog) lastProg = prog;
    var p = prog || lastProg;
    var gutter = document.getElementById(GUTTER_ID);
    if (!gutter || !p || !p.rustLines) return;

    // Clear any stale highlight state on the wrapper.
    var wrap = gutter.closest('.code-with-gutter');
    if (wrap) clearHighlight(wrap);

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

    // Tooltip: show on hover anywhere in the column.
    col.addEventListener('mouseenter', function () {
      showTooltip(col, flag, lineCount);
    });
    col.addEventListener('mouseleave', function () {
      hideTooltip(col);
    });

    // Click delegation for bar segments inside this column.
    col.addEventListener('click', function (e) {
      var seg = e.target.closest('.bar-segment');
      if (!seg) return;
      e.stopPropagation();
      var wrap = col.closest('.code-with-gutter');
      if (!wrap) return;
      var from = Number(seg.getAttribute('data-from-line'));
      var to = Number(seg.getAttribute('data-to-line'));
      var alreadyActive =
        wrap.classList.contains('is-highlighting') &&
        wrap.classList.contains('is-highlighting-' + flag) &&
        Number(wrap.style.getPropertyValue('--hl-from')) === from &&
        Number(wrap.style.getPropertyValue('--hl-to')) === to;
      if (alreadyActive) {
        clearHighlight(wrap);
      } else {
        applyHighlight(wrap, flag, from, to);
      }
    });

    return col;
  }

  function buildTooltip() {
    var tip = document.createElement('div');
    tip.className = 'provenance-tooltip';
    tip.id = TIP_ID;
    tip.hidden = true;
    return tip;
  }

  function showTooltip(col, flag, lineCount) {
    var gutter = col.parentNode;
    if (!gutter) return;
    var tip = gutter.querySelector('#' + TIP_ID);
    if (!tip) return;
    tip.textContent =
      '--' + flag + '  ·  ' + lineCount + ' line' + (lineCount === 1 ? '' : 's');
    tip.hidden = false;
    // Position relative to the gutter; align with the hovered column.
    var gRect = gutter.getBoundingClientRect();
    var cRect = col.getBoundingClientRect();
    tip.style.left = cRect.left - gRect.left + cRect.width / 2 + 'px';
    tip.style.top = '0px';
  }

  function hideTooltip(col) {
    var gutter = col.parentNode;
    if (!gutter) return;
    var tip = gutter.querySelector('#' + TIP_ID);
    if (tip) tip.hidden = true;
  }

  function applyHighlight(wrap, flag, from, to) {
    // Strip any previous flag-specific class.
    Array.prototype.slice.call(wrap.classList).forEach(function (cls) {
      if (cls.indexOf('is-highlighting-') === 0) wrap.classList.remove(cls);
    });
    wrap.classList.add('is-highlighting');
    wrap.classList.add('is-highlighting-' + flag);
    wrap.style.setProperty('--hl-from', String(from));
    wrap.style.setProperty('--hl-to', String(to));
  }

  function clearHighlight(wrap) {
    Array.prototype.slice.call(wrap.classList).forEach(function (cls) {
      if (cls === 'is-highlighting' || cls.indexOf('is-highlighting-') === 0) {
        wrap.classList.remove(cls);
      }
    });
    wrap.style.removeProperty('--hl-from');
    wrap.style.removeProperty('--hl-to');
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.bar-segment')) return; // handled in column listener
    var wrap = document.querySelector('.code-with-gutter.is-highlighting');
    if (wrap) clearHighlight(wrap);
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
