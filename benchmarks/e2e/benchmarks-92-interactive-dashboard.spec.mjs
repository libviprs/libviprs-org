// libviprs-org#92: the interactive dashboard sits alongside the generated page.
//
// benchmarks/index.html is generated static HTML and a required job checks its
// numbers against an archived document. The interactive view from libviprs-bench
// reads the same history.json and adds filtering, pan and zoom. These specs are
// written before the wiring and are red against a page that loads no dashboard.
// They drive the real page: does it draw, does it react, is it styled (the CSS
// shares no class names with the generated page, and reads tokens this site does
// not define), and can it be read in both themes.

import { test, expect } from '@playwright/test';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ratio } from './contrast.mjs';

const PAGE = '/benchmarks/';
const HERE = fileURLToPath(new URL('.', import.meta.url));
// Read lazily and tolerantly: before the wiring these files do not exist, and a
// spec file that throws on import is red for the wrong reason.
const readOrNull = (rel) => { try { return readFileSync(`${HERE}${rel}`, 'utf8'); } catch { return null; } };
const BRIDGE = readOrNull('../css/dashboard-bridge.css');
const VENDORED_CONFIG = readOrNull('../vendor/dashboard-config.json');

const SCHEMES = ['light', 'dark'];
const AA = 4.5;

/** Inline SVG charts that are not the dashboard's: the ones render-latest.mjs
 *  writes into the generated page, which have to survive the wiring untouched. */
const staticCharts = (page) => page.evaluate(() =>
  [...document.querySelectorAll('svg')].filter((s) => !s.closest('#dashboard-root')).length);

function note(line) {
  console.log(line);
  if (process.env.E2E_RATIOS) appendFileSync(process.env.E2E_RATIOS, `${line}\n`);
}

/** Open the page in a scheme, with the page's own theme switch agreeing, and wait
 *  for the dashboard to have drawn. Errors and failed requests are collected so a
 *  dashboard that "rendered" while logging a stack trace does not pass. */
async function openDashboard(browser, scheme, viewport = { width: 1100, height: 800 }) {
  const context = await browser.newContext({ colorScheme: scheme, viewport });
  const page = await context.newPage();
  const problems = [];
  const requests = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  // A resource that fails to load logs a generic console error with no URL, so
  // those are judged by `requestfailed` below and only for this site's own
  // origin: an outside font or icon the host cannot reach is not the dashboard.
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on('requestfailed', (r) => {
    const u = new URL(r.url());
    if (u.hostname === '127.0.0.1') problems.push(`request failed: ${u.pathname} ${r.failure()?.errorText ?? ''}`);
    else note(`ignored, cross-origin: ${u.origin}${u.pathname}`);
  });
  page.on('response', (r) => { requests.push({ url: new URL(r.url()).pathname, status: r.status() }); });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => document.documentElement.setAttribute('data-theme', s), scheme);
  await page.locator('#dashboard-root .bench-section-card').first().waitFor({ timeout: 60_000 });
  return { context, page, problems, requests };
}

test.describe('#92 the dashboard is wired in', () => {
  test('#92 it loads its config and script, reads the same history.json, and draws without errors', async ({ browser }) => {
    const { context, page, problems, requests } = await openDashboard(browser, 'light');
    const seen = (path) => requests.find((r) => r.url === path);
    expect(seen('/benchmarks/vendor/dashboard-config.json')?.status, 'config fetched').toBe(200);
    expect(seen('/benchmarks/vendor/dashboard.js')?.status, 'script fetched').toBe(200);
    expect(seen('/benchmarks/vendor/dashboard.css')?.status, 'stylesheet fetched').toBe(200);
    expect(seen('/benchmarks/history.json')?.status, 'the same history.json the page is generated from').toBe(200);
    expect(await page.locator('#dashboard-root .bench-section-card').count()).toBeGreaterThan(0);
    expect(await page.locator('#dashboard-root svg').count(), 'it draws charts').toBeGreaterThan(0);
    expect(requests.filter((r) => r.status >= 400), 'no failed request').toEqual([]);
    expect(problems, 'no page error and no console error').toEqual([]);
    await context.close();
  });

  test('#92 it sits outside the generated markers, so the generated page is unchanged', async ({ browser }) => {
    const { context, page } = await openDashboard(browser, 'light');
    const inside = await page.evaluate(() => {
      const root = document.getElementById('dashboard-root');
      // Walk the comment nodes: the dashboard must not be between a
      // GENERATED:*:BEGIN and its END, or --check would be fighting it.
      const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_ELEMENT);
      let depth = 0; let found = false;
      for (let n = w.currentNode; n; n = w.nextNode()) {
        if (n.nodeType === Node.COMMENT_NODE) {
          if (/GENERATED:[\w-]+:BEGIN/.test(n.data)) depth++;
          if (/GENERATED:[\w-]+:END/.test(n.data)) depth--;
        } else if (n === root) { found = depth > 0; break; }
      }
      return found;
    });
    expect(inside, '#dashboard-root is between GENERATED markers').toBe(false);
    // And the static charts the generated page already had are all still there.
    expect(await staticCharts(page), 'the static inline charts').toBeGreaterThanOrEqual(10);
    await context.close();
  });

  test('#92 the page says what the view needs and what it does without it', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#dashboard-root noscript, #interactive')).not.toHaveCount(0);
    const text = await page.locator('#interactive').innerText();
    expect(text).toMatch(/JavaScript/i);
    expect(await staticCharts(page), 'the static charts do not need script').toBeGreaterThanOrEqual(10);
    await context.close();
  });

  test('#92 a failed config fetch says so on the page instead of leaving a blank box', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('**/vendor/dashboard-config.json', (r) => r.fulfill({ status: 404, body: 'nope' }));
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#dashboard-root')).toContainText(/did not load/i, { timeout: 30_000 });
    await context.close();
  });
});

test.describe('#92 it is interactive', () => {
  test('#92 a library filter chip changes what each chart draws', async ({ browser }) => {
    const { context, page } = await openDashboard(browser, 'light');
    const chips = page.locator('#dashboard-root .filter-chip input[type="checkbox"]');
    expect(await chips.count(), 'filter chips').toBeGreaterThan(2);
    // A card that has points to draw: most of the memory and throughput cards
    // read n/a, because the dashboard charts milliseconds only.
    const chart = page.locator('#dashboard-root .bench-section-card:has(circle[data-series]) .bench-section-chart').first();
    // A library this chart actually draws. The history now holds writer sweeps and the PVec run,
    // whose cards draw other libraries than the first chip, and unchecking one a card does not
    // draw changes nothing in it. The whole dashboard is compared, because a card whose only
    // library was unchecked stops matching the locator above.
    const root = page.locator('#dashboard-root');
    const drawn = await chart.evaluate((el) => el.querySelector('[data-series]').getAttribute('data-series'));
    const before = await root.innerHTML();
    const lib = page.locator(`#dashboard-root input[type="checkbox"][aria-label^="library"][value="${drawn}"]:checked`).first();
    await lib.uncheck();
    const after = await root.innerHTML();
    expect(after, 'the dashboard redrew without that library').not.toEqual(before);
    await context.close();
  });

  test('#92 the wheel zooms a chart, a drag pans it and a double click resets both', async ({ browser }) => {
    const { context, page } = await openDashboard(browser, 'light');
    const chart = page.locator('#dashboard-root .bench-section-card:has(circle[data-series]) .bench-section-chart').first();
    await chart.scrollIntoViewIfNeeded();
    const rest = await chart.innerHTML();
    const box = await chart.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    const zoomed = await chart.innerHTML();
    expect(zoomed, 'the wheel changed the drawing').not.toEqual(rest);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, { steps: 4 });
    await page.mouse.up();
    expect(await chart.innerHTML(), 'dragging panned it').not.toEqual(zoomed);
    await chart.dblclick();
    expect(await chart.innerHTML(), 'double click returned to the resting view').toEqual(rest);
    await context.close();
  });
});

test.describe('#92 what it says', () => {
  // The label was a literal in the vendored script (libviprs-bench#129). The pinned
  // revision parameterises it, so the expected-failure annotation that said so is gone.
  test("#92 the Default view button names this project's series, not causl's", async ({ browser }) => {
    const { context, page } = await openDashboard(browser, 'light');
    const text = await page.locator('#dashboard-root .filter-action', { hasText: /default view/i }).first().innerText();
    expect(text).not.toMatch(/causl|mobx|redux/i);
    await context.close();
  });
});

test.describe('#92 it is styled', () => {
  test('#92 every custom property the vendored stylesheet reads resolves on this site', async ({ browser }) => {
    const { context, page } = await openDashboard(browser, 'light');
    const css = await (await page.request.get('/benchmarks/vendor/dashboard.css')).text();
    const names = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
    // Three are set by the dashboard on the element itself, per card or per chip.
    const setByDashboard = new Set(['--verdict-color', '--lib-color', '--skip-reason-color']);
    const missing = await page.evaluate((list) => {
      const root = document.getElementById('dashboard-root');
      const cs = getComputedStyle(root);
      return list.filter((n) => cs.getPropertyValue(n).trim() === '');
    }, names.filter((n) => !setByDashboard.has(n)));
    expect(missing, 'tokens the dashboard stylesheet reads that nothing defines').toEqual([]);
    await context.close();
  });

  test('#92 the filter shell and the cards are actually painted', async ({ browser }) => {
    const { context, page } = await openDashboard(browser, 'light');
    const paint = await page.evaluate(() => {
      const get = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
      const card = get('#dashboard-root .bench-section-card');
      const shell = get('#dashboard-root .filter-shell');
      return {
        card: card && { bg: card.backgroundColor, image: card.backgroundImage, border: card.borderTopWidth, pad: card.paddingTop },
        shell: shell && { border: shell.borderTopWidth, pad: shell.paddingTop },
      };
    });
    expect(paint.card, '.bench-section-card exists').toBeTruthy();
    expect(paint.card.bg !== 'rgba(0, 0, 0, 0)' || paint.card.image !== 'none', 'the card has a background (colour or gradient)').toBe(true);
    expect(parseFloat(paint.card.pad), 'the card is padded').toBeGreaterThan(0);
    expect(paint.shell, '.filter-shell exists').toBeTruthy();
    expect(parseFloat(paint.shell.pad), 'the filter shell is padded').toBeGreaterThan(0);
    await context.close();
  });

  test('#92 no horizontal scroll at phone width, in either theme', async ({ browser }) => {
    for (const scheme of SCHEMES) {
      const { context, page } = await openDashboard(browser, scheme, { width: 375, height: 800 });
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `${scheme}: the page overflows by ${over}px`).toBeLessThanOrEqual(0);
      await context.close();
    }
  });
});

/** Turn every library and scale chip on, so hidden series are measured too. */
async function showEverything(page) {
  await page.locator('#dashboard-root .filter-action', { hasText: /all/i }).first().click();
  await page.locator('#dashboard-root .bench-section-card').first().waitFor();
}

test.describe('#92 contrast, measured', () => {
  for (const scheme of SCHEMES) {
    test(`#92 the words around the dashboard meet AA on the page, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
      await page.evaluate((s) => document.documentElement.setAttribute('data-theme', s), scheme);
      const pairs = await page.evaluate(() => {
        const bgOf = (el) => {
          for (let n = el; n; n = n.parentElement) {
            const c = getComputedStyle(n).backgroundColor;
            if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
          }
          return 'rgb(255, 255, 255)';
        };
        return ['#interactive h2', '#interactive > p:not(.footnote)', '#interactive .footnote', '#interactive .footnote em', '#interactive a']
          .map((sel) => {
            const el = document.querySelector(sel);
            return el ? { sel, fg: getComputedStyle(el).color, bg: bgOf(el) } : { sel, missing: true };
          });
      });
      for (const p of pairs) {
        expect(p.missing, `${p.sel} is on the page`).toBeFalsy();
        const r = ratio(p.fg, p.bg);
        note(`${scheme} ${p.sel} ${p.fg} on ${p.bg} = ${r.toFixed(2)}:1 (needs 4.5)`);
        expect(r, `${scheme} ${p.sel}`).toBeGreaterThanOrEqual(AA);
      }
      await context.close();
    });
  }

  test('#92 every series in the vendored config has a colour for each theme in the bridge', async () => {
    // The bridge picks a readable variant of each series colour per theme. A
    // series added to the vendored config without an entry there would be drawn
    // in the config's own colour, unmeasured, which is the gap this closes.
    expect(VENDORED_CONFIG, 'vendor/dashboard-config.json exists').not.toBeNull();
    expect(BRIDGE, 'css/dashboard-bridge.css exists').not.toBeNull();
    const ids = JSON.parse(VENDORED_CONFIG).series.order;
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids) {
      // A custom property name cannot hold `@` or `+`, which the writer sweep's series ids do, so
      // the bridge names the property by the id with those characters turned into hyphens.
      const slug = id.replace(/[^A-Za-z0-9_-]/g, '-');
      const defs = BRIDGE.match(new RegExp(`--series-${slug}:`, 'g')) ?? [];
      expect(defs.length, `--series-${slug} is defined for light and for dark`).toBe(2);
    }
  });

  /** Everything a measurement needs, read in the page: each text node's colour and
   *  every background it might sit on. A background here can be a translucent
   *  colour or a gradient, so it is composited layer by layer from the page down
   *  and a gradient contributes each of its stops. The ratio is then the worst
   *  one, which is the honest number for text that crosses a gradient. */
  async function measure(page) {
    return page.evaluate(() => {
      const parse = (c) => {
        const m = /rgba?\(([^)]+)\)/.exec(c);
        if (!m) return null;
        const p = m[1].split(',').map((x) => parseFloat(x));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const over = (top, under) => ({
        r: top.r * top.a + under.r * (1 - top.a),
        g: top.g * top.a + under.g * (1 - top.a),
        b: top.b * top.a + under.b * (1 - top.a),
        a: 1,
      });
      const stopsOf = (img) => (/gradient/.test(img) ? [...img.matchAll(/rgba?\([^)]*\)/g)].map((m) => parse(m[0])) : []);
      const backgrounds = (el) => {
        const chain = [];
        for (let n = el; n; n = n.parentElement) chain.unshift(n);
        let cands = [{ r: 255, g: 255, b: 255, a: 1 }];
        for (const n of chain) {
          const cs = getComputedStyle(n);
          const c = parse(cs.backgroundColor);
          if (c && c.a > 0) cands = cands.map((u) => over(c, u));
          const stops = stopsOf(cs.backgroundImage);
          if (stops.length) cands = cands.flatMap((u) => stops.map((s) => over(s, u)));
        }
        return cands.map((c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`);
      };
      const root = document.getElementById('dashboard-root');
      const out = [];
      const seen = new Set();
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        const text = t.nodeValue.trim();
        if (!text) continue;
        const el = t.parentElement;
        // SVG <title> is a tooltip the browser draws itself, not page text.
        if (el.closest('noscript') || el.tagName.toLowerCase() === 'title') continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const svg = el.closest('svg');
        const fg = parse(svg ? cs.fill : cs.color);
        if (!fg) continue;
        const sel = `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
        const bgs = backgrounds(svg ? svg.parentElement : el);
        const key = `${sel}|${cs.color}|${cs.fill}|${bgs.join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          sel, sample: text.slice(0, 36), fg: `rgb(${fg.r}, ${fg.g}, ${fg.b})`, alpha: fg.a, bgs,
          size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) || 400,
        });
      }
      const cs = getComputedStyle(root);
      const vars = {};
      for (const k of ['pass', 'regressed', 'improved', 'noisy', 'unknown']) vars[k] = cs.getPropertyValue(`--verdict-${k}`).trim();
      const card = root.querySelector('.bench-section-card');
      return { pairs: out, vars, cardBgs: card ? backgrounds(card) : [] };
    });
  }

  for (const scheme of SCHEMES) {
    test(`#92 the verdict colours are readable on the card, ${scheme}`, async ({ browser }) => {
      // The five verdict states the legend and the chips can show. This data only
      // exercises "unknown", so the others are measured from the colours the page
      // gives them rather than waiting for a run that regresses.
      const { context, page } = await openDashboard(browser, scheme);
      const { vars, cardBgs } = await measure(page);
      expect(cardBgs.length, 'the card background was resolved').toBeGreaterThan(0);
      for (const [kind, colour] of Object.entries(vars)) {
        expect(colour, `--verdict-${kind} is defined`).toMatch(/^#/);
        const r = Math.min(...cardBgs.map((bg) => ratio(colour, bg)));
        note(`${scheme} verdict ${kind} ${colour} on the card = ${r.toFixed(2)}:1 (needs 4.5)`);
        expect(r, `${scheme} verdict ${kind}`).toBeGreaterThanOrEqual(AA);
      }
      await context.close();
    });

    test(`#92 every piece of dashboard text meets AA, ${scheme}`, async ({ browser }) => {
      const { context, page } = await openDashboard(browser, scheme);
      await showEverything(page);
      const { pairs } = await measure(page);
      expect(pairs.length, 'text was found to measure').toBeGreaterThan(10);
      const failures = [];
      let worst = Infinity;
      for (const p of pairs) {
        const large = p.size >= 24 || (p.size >= 18.66 && p.weight >= 700);
        const need = large ? 3 : AA;
        // Translucent text is composited over each background it can sit on.
        const rs = p.bgs.map((bg) => {
          if (p.alpha >= 1) return ratio(p.fg, bg);
          const [br, bgc, bb] = bg.match(/\d+/g).map(Number);
          const [fr, fg2, fb] = p.fg.match(/[\d.]+/g).map(Number);
          const mix = `rgb(${fr * p.alpha + br * (1 - p.alpha)}, ${fg2 * p.alpha + bgc * (1 - p.alpha)}, ${fb * p.alpha + bb * (1 - p.alpha)})`;
          return ratio(mix, bg);
        });
        const r = Math.min(...rs);
        worst = Math.min(worst, r);
        note(`${scheme} ${p.sel} "${p.sample}" ${p.fg} on ${p.bgs.length > 1 ? `${p.bgs.length} gradient stops` : p.bgs[0]} = ${r.toFixed(2)}:1 (needs ${need})`);
        if (r < need) failures.push(`${p.sel} "${p.sample}" ${r.toFixed(2)}:1 < ${need}`);
      }
      note(`${scheme} dashboard text: ${pairs.length} distinct pairs, worst ${worst.toFixed(2)}:1`);
      expect(failures, `${scheme}: text under AA`).toEqual([]);
      await context.close();
    });

    test(`#92 the series lines and markers meet 3:1 against the card, ${scheme}`, async ({ browser }) => {
      // Non-text contrast (WCAG 1.4.11): a line you cannot see against its card
      // is a series you cannot read. Measured on the stroke the dashboard draws.
      const { context, page } = await openDashboard(browser, scheme);
      await showEverything(page);
      const series = await page.evaluate(() => {
        const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const p = m[1].split(',').map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
        const over = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
        const stops = (img) => (/gradient/.test(img) ? [...img.matchAll(/rgba?\([^)]*\)/g)].map((m) => parse(m[0])) : []);
        const bgs = (el) => {
          const chain = []; for (let n = el; n; n = n.parentElement) chain.unshift(n);
          let cands = [{ r: 255, g: 255, b: 255, a: 1 }];
          for (const n of chain) { const cs = getComputedStyle(n); const c = parse(cs.backgroundColor); if (c && c.a > 0) cands = cands.map((u) => over(c, u)); const st = stops(cs.backgroundImage); if (st.length) cands = cands.flatMap((u) => st.map((s) => over(s, u))); }
          return cands.map((c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`);
        };
        const seen = new Map();
        for (const p of document.querySelectorAll('#dashboard-root path[data-series][stroke]:not([stroke="none"])')) {
          const lib = p.getAttribute('data-series');
          const stroke = getComputedStyle(p).stroke;
          if (!seen.has(lib)) seen.set(lib, { lib, stroke, bgs: bgs(p.closest('svg').parentElement) });
        }
        return [...seen.values()];
      });
      expect(series.length, 'series were drawn').toBeGreaterThan(1);
      const failures = [];
      for (const s of series) {
        const r = Math.min(...s.bgs.map((bg) => ratio(s.stroke, bg)));
        note(`${scheme} series ${s.lib} line ${s.stroke} on the card = ${r.toFixed(2)}:1 (needs 3)`);
        if (r < 3) failures.push(`${s.lib} ${r.toFixed(2)}:1`);
      }
      expect(failures, `${scheme}: series lines under 3:1`).toEqual([]);
      await context.close();
    });
  }
});
