// libviprs-org#91: the benchmarks page shows file-based charts, drawn at ingest.
//
//   <img src="charts/storage_open_p50.svg">   as on causl.org, not inline <svg>
//
// These are written before the fix and are red against a page with no charts
// section. They drive the real page in a real browser, because what the issue is
// about is what a visitor sees: whether the images arrive, whether they draw in
// both themes, and whether the words around them are readable.

import { test, expect } from '@playwright/test';
import { ratio, chartTokens, chartTextFills, resolveFill } from './contrast.mjs';

const PAGE = '/benchmarks/';
const SCHEMES = ['light', 'dark'];
// The surface each scheme's chart paints for itself. Read from the charts
// below as well; this is the independent expectation the pixel check uses.
const SURFACE = { light: [255, 255, 255], dark: [26, 26, 25] };

async function manifest(request) {
  const r = await request.get('/benchmarks/charts/manifest.json');
  expect(r.ok(), 'charts/manifest.json is served').toBeTruthy();
  return r.json();
}

/** Scroll every lazy image into view and wait for it to finish. */
async function loadAll(page) {
  const imgs = page.locator('img[src^="charts/"]');
  const n = await imgs.count();
  for (let i = 0; i < n; i++) await imgs.nth(i).scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => [...document.querySelectorAll('img[src^="charts/"]')].every((i) => i.complete),
    null,
    { timeout: 15_000 },
  );
  return n;
}

test.describe('#91 charts are files, embedded as images', () => {
  test('#91 the page embeds one <img> per chart the pinned renderer drew', async ({ page, request }) => {
    const m = await manifest(request);
    await page.goto(PAGE);
    const imgs = page.locator('#charts img[src^="charts/"]');
    await expect(imgs).toHaveCount(m.charts.length);
    expect(m.charts.length, 'the renderer drew something').toBeGreaterThan(0);
    const srcs = await imgs.evaluateAll((els) => els.map((e) => e.getAttribute('src')));
    expect(srcs.sort()).toEqual(m.charts.map((c) => `charts/${c.file}`).sort());
    // And not drawn a second way: the section is images, not inline SVG.
    await expect(page.locator('#charts svg')).toHaveCount(0);
  });

  test('#91 every chart file loads and has a size', async ({ page }) => {
    await page.goto(PAGE);
    const n = await loadAll(page);
    expect(n).toBeGreaterThan(0);
    const broken = await page.locator('img[src^="charts/"]').evaluateAll((els) =>
      els.filter((e) => !(e.naturalWidth > 0 && e.naturalHeight > 0)).map((e) => e.getAttribute('src')));
    expect(broken, 'images that did not decode').toEqual([]);
  });

  test('#91 every chart has distinct alt text and reserves its box before it loads', async ({ page }) => {
    await page.goto(PAGE);
    const info = await page.locator('#charts img').evaluateAll((els) =>
      els.map((e) => ({ alt: e.alt, w: e.getAttribute('width'), h: e.getAttribute('height') })));
    expect(info.length).toBeGreaterThan(0);
    for (const i of info) {
      expect(i.alt.trim().length, 'alt text').toBeGreaterThan(3);
      expect(Number(i.w) > 0 && Number(i.h) > 0, `width and height attributes (${i.w}x${i.h})`).toBeTruthy();
    }
    expect(new Set(info.map((i) => i.alt)).size, 'alt texts are distinct').toBe(info.length);
  });

  for (const scheme of SCHEMES) {
    test(`#91 the charts paint their own ${scheme} surface`, async ({ browser }) => {
      // An <img> cannot see the page's data-theme, only the visitor's system
      // setting, so this is what proves the file honours prefers-color-scheme.
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await page.goto(PAGE);
      await loadAll(page);
      const px = await page.locator('#charts img').evaluateAll((els) =>
        els.slice(0, 5).map((img) => {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0);
          return [...g.getImageData(2, 2, 1, 1).data].slice(0, 3);
        }));
      expect(px.length).toBeGreaterThan(0);
      for (const p of px) expect(p, `surface pixel in ${scheme}`).toEqual(SURFACE[scheme]);
      await context.close();
    });
  }

  test('#91 no horizontal scroll at phone width, in either scheme', async ({ browser }) => {
    for (const scheme of SCHEMES) {
      const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 375, height: 800 } });
      const page = await context.newPage();
      await page.goto(PAGE);
      await loadAll(page);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `${scheme}: page overflows by ${over}px`).toBeLessThanOrEqual(0);
      const wide = await page.locator('#charts img').evaluateAll((els) =>
        els.filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).length);
      expect(wide, `${scheme}: charts wider than the viewport`).toBe(0);
      await context.close();
    }
  });
});

test.describe('#91 contrast, measured', () => {
  // WCAG AA: 4.5:1 for normal text. Every number is printed so it can be quoted.
  const AA = 4.5;

  test('#91 chart text meets AA against the chart surface (primary and secondary text)', async ({ request }) => {
    const m = await manifest(request);
    const svg = await (await request.get(`/benchmarks/charts/${m.charts[0].file}`)).text();
    const tokens = chartTokens(svg);
    const report = [];
    for (const scheme of SCHEMES) {
      const t = tokens[scheme];
      for (const fill of chartTextFills(svg).keys()) {
        if (fill === 'var(--bc-muted)') continue; // its own test below
        const fg = resolveFill(fill, t);
        const r = ratio(fg, t['--bc-surface']);
        report.push(`${scheme} ${fill} ${fg} on ${t['--bc-surface']} = ${r.toFixed(2)}:1`);
        expect(r, report.at(-1)).toBeGreaterThanOrEqual(AA);
      }
    }
    console.log(report.join('\n'));
  });

  // The axis tick labels use --bc-muted. Measured, it is under 4.5:1 in the
  // light scheme. The token is the pinned renderer's (bencharts), not this
  // repository's, so it cannot be fixed here without making the charts differ
  // from what the pinned revision draws, which is exactly what --check refuses.
  // Marked as an expected failure so it stays visible and turns red the day it
  // is fixed upstream, at which point this annotation goes.
  test('#91 axis tick labels (--bc-muted) meet AA in both schemes', async ({ request }) => {
    test.fail(true, 'upstream: --bc-muted is below 4.5:1 on the light surface; see the issue linked in the PR');
    const m = await manifest(request);
    const svg = await (await request.get(`/benchmarks/charts/${m.charts[0].file}`)).text();
    const tokens = chartTokens(svg);
    for (const scheme of SCHEMES) {
      const t = tokens[scheme];
      const r = ratio(t['--bc-muted'], t['--bc-surface']);
      console.log(`${scheme} --bc-muted ${t['--bc-muted']} on ${t['--bc-surface']} = ${r.toFixed(2)}:1`);
      expect(r).toBeGreaterThanOrEqual(AA);
    }
  });

  for (const scheme of SCHEMES) {
    test(`#91 the words around the charts meet AA on the page, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await page.goto(PAGE);
      // The page's own theme switch is data-theme on <html>; set it to the
      // scheme under test so the page and the emulation agree.
      await page.evaluate((s) => document.documentElement.setAttribute('data-theme', s), scheme);
      const pairs = await page.evaluate(() => {
        const bgOf = (el) => {
          for (let n = el; n; n = n.parentElement) {
            const c = getComputedStyle(n).backgroundColor;
            if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
          }
          return 'rgb(255, 255, 255)';
        };
        return ['#charts h2', '#charts .lead', '#charts .status-callout p', '#charts .chart-file-group h3', '#charts figcaption', '#charts .section-kicker']
          .map((sel) => {
            const el = document.querySelector(sel);
            return el ? { sel, fg: getComputedStyle(el).color, bg: bgOf(el) } : { sel, missing: true };
          });
      });
      for (const p of pairs) {
        expect(p.missing, `${p.sel} is on the page`).toBeFalsy();
        const r = ratio(p.fg, p.bg);
        console.log(`${scheme} ${p.sel} ${p.fg} on ${p.bg} = ${r.toFixed(2)}:1`);
        expect(r, `${scheme} ${p.sel}`).toBeGreaterThanOrEqual(AA);
      }
      await context.close();
    });
  }
});
