/* Slide-over checklist drawer + scroll-jump FAB.
 *
 * Two surface-level UIs that hook off the generator state:
 *
 *  1. Checklist drawer — pinned to the viewport's right edge with a tab
 *     handle on its left. Closed by default. cli.js calls
 *     `window.Checklist.update(state)` after each render; the items are
 *     recomputed and the drawer auto-opens on a fresh completion (unless
 *     the user manually closed it via the tab).
 *
 *  2. Scroll-jump FAB — sits to the left of the copy-to-clipboard button.
 *     Both share the same `.is-active` gate (toggled by cli.js when
 *     prog.count > 0). The chevron flips: down when the rust block is
 *     off-screen (click → smooth-scroll to it), up when it's in view
 *     (click → smooth-scroll back to the last selected flag's <dt>).
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Checklist
  // ---------------------------------------------------------------------------

  var DRAWER_ID = 'checklistDrawer';
  var TAB_ID    = 'checklistTab';
  var LIST_ID   = 'checklistList';
  var SUMMARY_ID = 'checklistSummary';
  var BADGE_ID   = 'checklistBadge';

  // True when the user explicitly closed the drawer via the tab. While
  // true, we don't auto-open it on completion. Reset to false when they
  // explicitly open it again.
  var userManuallyClosed = false;
  // Prior items by id → done state, for newly-completed detection.
  var lastDone = {};

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  // The checklist content. Each item carries an `appliesIf` predicate
  // so conditional items (DPI for --render, etc.) only show when relevant.
  function compute(state) {
    var inputSet  = !!(state.inputPath  && state.inputPath  !== 'input.pdf');
    var outputSet = !!(state.outputPath && state.outputPath !== 'tiles/');

    var items = [
      {
        id: 'input',
        label: 'Set the input path',
        detail: 'Path to a PDF or image — e.g. <code>./scan.pdf</code>',
        done: inputSet,
        applies: true,
        target: { selector: '#genArgInput', focus: true },
      },
      {
        id: 'output',
        label: 'Set the output directory',
        detail: 'Where tiles will be written — e.g. <code>./tiles</code>',
        done: outputSet,
        applies: true,
        target: { selector: '#genArgOutput', focus: true },
      },
      {
        id: 'one-flag',
        label: 'Pick at least one option',
        detail: 'Tile size, format, layout, etc. — defaults work, but customise for production',
        done: state.flagsCount > 0,
        applies: true,
        // List of flags — jump to the first row.
        target: { selector: 'dl.flags dt.flag-row' },
      },
      {
        id: 'render-dpi',
        label: 'Set --dpi for vector PDF rendering',
        detail: '<code>--render</code> rasterises a vector PDF; pair with <code>--dpi</code> to control resolution',
        done: !!state.dpiSet,
        applies: !!state.hasRender,
        target: { selector: '#flag-dpi' },
      },
      {
        id: 'sink-feature',
        label: 'Enable the matching Cargo feature',
        detail: 'Build with <code>--features s3</code> or <code>--features packfile</code> when using <code>--sink</code>',
        done: false,           // can't verify cargo flags from the page, so this stays "todo"
        applies: !!state.hasSinkOverride,
        target: { selector: '#flag-sink' },
      },
      {
        id: 'jpeg-quality',
        label: 'Pick a JPEG quality level',
        detail: '<code>--quality</code> only matters when <code>--format jpeg</code> is set',
        done: !!state.qualitySet,
        applies: !!state.formatIsJpeg,
        target: { selector: '#flag-quality', focus: true },
      },
    ];

    return items.filter(function (i) { return i.applies; });
  }

  function update(state) {
    var drawer = document.getElementById(DRAWER_ID);
    if (!drawer) return;
    var list = drawer.querySelector('#' + LIST_ID);
    var summaryEl = drawer.querySelector('#' + SUMMARY_ID);
    var badge = drawer.querySelector('#' + BADGE_ID);
    if (!list) return;

    var items = compute(state || {});
    var doneCount = items.filter(function (i) { return i.done; }).length;

    // Detect newly-completed items vs. the prior render so we can pulse them.
    var newlyDoneIds = items
      .filter(function (i) { return i.done && !lastDone[i.id]; })
      .map(function (i) { return i.id; });

    list.innerHTML = items.map(function (item) {
      var icon = item.done ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle';
      var hasJump = !!(item.target && item.target.selector);
      // Heading + mark are wrapped in a button when there's a jump target so
      // they're keyboard-focusable and announce as a control. The detail row
      // stays plain text underneath.
      var heading = hasJump
        ? (
            '<button type="button" class="checklist-jump"' +
            ' data-target="' + escapeHtml(item.target.selector) + '"' +
            ' data-focus="' + (item.target.focus ? '1' : '0') + '"' +
            ' aria-label="Jump to: ' + escapeHtml(item.label) + '">' +
            '  <span class="checklist-mark"><i class="' + icon + '" aria-hidden="true"></i></span>' +
            '  <span class="checklist-text">' + escapeHtml(item.label) + '</span>' +
            '</button>'
          )
        : (
            '<span class="checklist-mark"><i class="' + icon + '" aria-hidden="true"></i></span>' +
            '<span class="checklist-text">' + escapeHtml(item.label) + '</span>'
          );
      return (
        '<li class="checklist-item' + (item.done ? ' is-done' : '') + '" data-id="' + item.id + '">' +
        heading +
        '  <span class="checklist-detail">' + item.detail + '</span>' +
        '</li>'
      );
    }).join('');

    if (summaryEl) {
      summaryEl.textContent = doneCount + ' of ' + items.length + ' steps complete';
    }
    if (badge) {
      var remaining = items.length - doneCount;
      badge.textContent = remaining ? String(remaining) : '✓';
      badge.dataset.progress = remaining ? '1' : '0';
    }

    // Pulse the rows that just turned green.
    newlyDoneIds.forEach(function (id) {
      var row = list.querySelector('[data-id="' + id + '"]');
      if (!row) return;
      row.classList.add('just-completed');
      setTimeout(function () { row.classList.remove('just-completed'); }, 2500);
    });

    // Auto-open the drawer when something just completed — but respect a
    // manual close.
    if (newlyDoneIds.length && !userManuallyClosed && !drawer.classList.contains('is-open')) {
      setOpen(drawer, true);
    }

    // Update the lastDone snapshot.
    var nextDone = {};
    items.forEach(function (i) { if (i.done) nextDone[i.id] = true; });
    lastDone = nextDone;
  }

  function setOpen(drawer, open) {
    drawer.classList.toggle('is-open', !!open);
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
  }

  // Scroll a checklist target into view, then (when meaningful) focus the
  // primary input so the user can start typing immediately. For dt.flag-row
  // targets we expand the row and focus its value input if present.
  function jumpToTarget(selector, focus) {
    if (!selector) return;
    var el = document.querySelector(selector);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Bare inputs: focus directly.
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      // Wait one tick so the smooth scroll doesn't fight with focus().
      setTimeout(function () { try { el.focus({ preventScroll: true }); el.select && el.select(); } catch (_) {} }, 350);
      return;
    }
    // Flag rows: expand them and pick the matching input/checkbox.
    if (el.classList && el.classList.contains('flag-row')) {
      el.classList.add('expanded');
      // Pulse hint so the user can see where they landed.
      el.classList.add('checklist-flash');
      setTimeout(function () { el.classList.remove('checklist-flash'); }, 1600);
      if (focus) {
        setTimeout(function () {
          var inner = el.querySelector('.flag-value, input[type="text"], input[type="number"], select');
          if (inner) {
            try { inner.focus({ preventScroll: true }); inner.select && inner.select(); } catch (_) {}
            return;
          }
          var check = el.querySelector('.flag-check');
          if (check) { try { check.focus({ preventScroll: true }); } catch (_) {} }
        }, 350);
      }
    }
  }

  function initChecklist() {
    var drawer = document.getElementById(DRAWER_ID);
    var tab = document.getElementById(TAB_ID);
    if (!drawer || !tab) return;

    // Delegated handler: each item heading is rendered as <button.checklist-jump>.
    // Re-renders blow away the inner DOM, so listening on the list keeps it
    // alive without re-binding.
    var list = drawer.querySelector('#' + LIST_ID);
    if (list) {
      list.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest && e.target.closest('.checklist-jump');
        if (!btn) return;
        e.preventDefault();
        jumpToTarget(btn.dataset.target, btn.dataset.focus === '1');
      });
    }

    tab.addEventListener('click', function () {
      var wasOpen = drawer.classList.contains('is-open');
      setOpen(drawer, !wasOpen);
      // Track manual close. If the user manually opened it (was-closed →
      // now-open), forget any prior manual-close so future completions
      // can auto-open again.
      userManuallyClosed = wasOpen;
    });

    // Esc closes the drawer when it's open.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer.classList.contains('is-open')) {
        setOpen(drawer, false);
        userManuallyClosed = true;
      }
    });

    // Render once with an empty state so the tab badge / list aren't blank.
    update({});
  }

  // ---------------------------------------------------------------------------
  // Scroll-jump FAB
  // ---------------------------------------------------------------------------

  // Tracks whether the generated rust block is currently visible. When true,
  // clicking the button jumps "back up" to the last selected flag; when
  // false, it jumps "down" to the generated code.
  var generatedCodeInView = false;

  function setChevron(btn, direction) {
    if (!btn) return;
    var icon = btn.querySelector('i');
    if (!icon) return;
    icon.className = direction === 'up'
      ? 'fa-solid fa-chevron-up'
      : 'fa-solid fa-chevron-down';
    btn.setAttribute('aria-label',
      direction === 'up'
        ? 'Jump back to the last selected flag'
        : 'Jump to the generated Rust code'
    );
  }

  function lastSelectedFlagDt() {
    var checked = document.querySelectorAll('dl.flags dt.flag-row .flag-check:checked');
    if (!checked.length) return null;
    return checked[checked.length - 1].closest('.flag-row');
  }

  function generatorPanel() {
    return document.getElementById('cli-generator');
  }

  function initScrollJump() {
    var btn = document.getElementById('scrollJumpFloating');
    if (!btn) return;

    setChevron(btn, 'down');

    btn.addEventListener('click', function () {
      var rows = document.getElementById('genRustRows');
      var panel = generatorPanel();
      if (generatedCodeInView) {
        var dt = lastSelectedFlagDt();
        if (dt) {
          dt.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          var pyramid = document.getElementById('pyramid');
          if (pyramid) pyramid.scrollIntoView({ behavior: 'smooth' });
        }
      } else if (panel) {
        panel.scrollIntoView({ behavior: 'smooth' });
      } else if (rows) {
        rows.scrollIntoView({ behavior: 'smooth' });
      }
    });

    // Watch the generated code's visibility so the chevron always reflects
    // whether the user is "at" it.
    var target = document.getElementById('genRustRows');
    if (target && 'IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          generatedCodeInView = e.isIntersecting;
          setChevron(btn, generatedCodeInView ? 'up' : 'down');
        });
      }, { threshold: 0.18 });
      io.observe(target);
    }
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function init() {
    initChecklist();
    initScrollJump();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.Checklist = { update: update };
})();
