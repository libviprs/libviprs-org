// A recording of the interactive dashboard for the PR: scroll to it, filter a
// series off and on, zoom a chart with the wheel, drag it, double click to
// reset. One run per colour scheme. Skipped unless E2E_RECORD is set.
//
//   E2E_RECORD=/tmp/recordings npx playwright test benchmarks-92-walkthrough

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.E2E_RECORD;
test.skip(!OUT, 'set E2E_RECORD=<dir> to record');

for (const scheme of ['light', 'dark']) {
  test(`#92 walkthrough, ${scheme}`, async ({ browser }) => {
    mkdirSync(OUT, { recursive: true });
    const size = { width: 900, height: 620 };
    const context = await browser.newContext({
      colorScheme: scheme,
      viewport: size,
      recordVideo: { dir: join(OUT, `raw92-${scheme}`), size },
    });
    const page = await context.newPage();
    await page.goto('/benchmarks/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((s) => document.documentElement.setAttribute('data-theme', s), scheme);
    const root = page.locator('#dashboard-root');
    await root.locator('.bench-section-card').first().waitFor({ timeout: 60_000 });
    await page.locator('#interactive').scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);

    // Filter a library off and on again.
    const chip = root.locator('input[type="checkbox"][aria-label^="library"]:checked').first();
    await chip.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await chip.uncheck();
    await page.waitForTimeout(900);
    await chip.check();
    await page.waitForTimeout(700);

    // Zoom, pan and reset one chart.
    const chart = root.locator('.bench-section-card:has(circle[data-series]) .bench-section-chart').first();
    await chart.scrollIntoViewIfNeeded();
    const box = await chart.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(250); }
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 50, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    await chart.dblclick();
    await page.waitForTimeout(900);

    const video = page.video();
    await context.close();
    await video.saveAs(join(OUT, `92-dashboard-${scheme}.webm`));
  });
}
