// A recording of the charts section for the PR: scroll through it once in each
// colour scheme. It asserts a little (the section is there, the images drew) so
// it cannot record a blank page and call it evidence, and it is skipped unless
// E2E_RECORD is set, because a normal run has no use for video.
//
//   E2E_RECORD=/tmp/recordings npx playwright test benchmarks-91-walkthrough
//
// The .webm files it writes are turned into GIFs with ffmpeg afterwards.

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.E2E_RECORD;
test.skip(!OUT, 'set E2E_RECORD=<dir> to record');

for (const scheme of ['light', 'dark']) {
  test(`#91 walkthrough, ${scheme}`, async ({ browser }) => {
    mkdirSync(OUT, { recursive: true });
    const context = await browser.newContext({
      colorScheme: scheme,
      viewport: { width: 900, height: 620 },
      recordVideo: { dir: join(OUT, `raw-${scheme}`), size: { width: 900, height: 620 } },
    });
    const page = await context.newPage();
    await page.goto('/benchmarks/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((s) => document.documentElement.setAttribute('data-theme', s), scheme);
    const section = page.locator('#charts');
    await section.scrollIntoViewIfNeeded();
    await expect(section.locator('img').first()).toBeVisible();
    const imgs = section.locator('img');
    const n = await imgs.count();
    for (let i = 0; i < n; i += 3) {
      await imgs.nth(i).scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(500);
    const video = page.video();
    await context.close();
    await video.saveAs(join(OUT, `91-charts-${scheme}.webm`));
  });
}
