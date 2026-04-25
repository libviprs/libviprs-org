/* libviprs.org shared top bar — used on every page.
 *
 * Two responsibilities:
 *   1. Burger drawer (toggle .menu-open on the <header>; CSS handles the rest).
 *   2. Light/dark theme toggle (now lives inside the drawer, not on the bar).
 *
 * Both used to be inline-duplicated across index.html, benchmarks.html, and
 * cli/index.html. This script is the single source of truth.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Theme toggle
  // ---------------------------------------------------------------------------

  function initTheme() {
    var btn = document.getElementById('themeToggle');
    var glyph = btn && btn.querySelector('.theme-glyph');
    var label = btn && btn.querySelector('.theme-label');

    function applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      if (glyph) glyph.textContent = theme === 'dark' ? '☀' : '☾'; // sun / moon
      if (label) label.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
      try { localStorage.setItem('theme', theme); } catch (e) { /* ignore */ }
    }

    var saved = null;
    try { saved = localStorage.getItem('theme'); } catch (e) { /* ignore */ }

    if (saved === 'dark' || saved === 'light') {
      applyTheme(saved);
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      applyTheme('dark');
    } else {
      applyTheme('light');
    }

    if (btn) {
      btn.addEventListener('click', function () {
        var current = document.documentElement.getAttribute('data-theme');
        applyTheme(current === 'dark' ? 'light' : 'dark');
      });
    }

    // Track OS-level changes if the user hasn't pinned a preference.
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var listener = function (e) {
      var pinned = null;
      try { pinned = localStorage.getItem('theme'); } catch (err) { /* ignore */ }
      if (!pinned) applyTheme(e.matches ? 'dark' : 'light');
    };
    if (mq.addEventListener) mq.addEventListener('change', listener);
    else if (mq.addListener) mq.addListener(listener); // Safari < 14
  }

  // ---------------------------------------------------------------------------
  // Burger drawer
  // ---------------------------------------------------------------------------

  function initDrawer() {
    var bar = document.getElementById('topbar');
    var burger = document.getElementById('topbarBurger');
    var menu = document.getElementById('topbar-menu');
    if (!bar || !burger || !menu) return;

    function setOpen(open) {
      if (open) bar.classList.add('menu-open');
      else bar.classList.remove('menu-open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      menu.setAttribute('aria-hidden', open ? 'false' : 'true');
    }

    burger.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(!bar.classList.contains('menu-open'));
    });

    // Tap a link → drawer closes so the navigation feels snappy.
    menu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { setOpen(false); });
    });

    // Click anywhere outside the drawer closes it.
    document.addEventListener('click', function (e) {
      if (!bar.classList.contains('menu-open')) return;
      if (bar.contains(e.target)) return;
      setOpen(false);
    });

    // Esc closes; restore focus to the burger so keyboard users don't lose context.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && bar.classList.contains('menu-open')) {
        setOpen(false);
        burger.focus();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  ready(function () {
    initTheme();
    initDrawer();
  });
})();
