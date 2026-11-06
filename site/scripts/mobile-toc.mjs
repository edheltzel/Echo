import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { serveDist } from './serve-dist.mjs';

const { server, base } = await serveDist();
let browser;

async function expectSection(page, slug) {
  await page.waitForFunction((value) => document.querySelector('[data-nb-mobile-toc-select]')?.value === value,
    slug, { timeout: 3000 });
}

async function scrollInside(page, slug) {
  await page.evaluate((id) => {
    const heading = document.getElementById(id);
    window.scrollTo({ top: heading.getBoundingClientRect().top + scrollY + 500, behavior: 'instant' });
  }, slug);
}

try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  for (const reducedMotion of ['reduce', 'no-preference']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion });
    try {
      const page = await context.newPage();
      await page.goto(`${base}/docs/http-api/`);
      await page.evaluate(() => document.fonts.ready);
      await expectSection(page, '_top');

      await scrollInside(page, 'native-terminal-visual-delivery');
      await expectSection(page, 'native-terminal-visual-delivery');
      assert.ok(await page.evaluate(() => {
        const heading = document.getElementById('native-terminal-visual-delivery');
        const next = document.getElementById('converse-playback-status-opt-in');
        return heading.getBoundingClientRect().bottom < 0 && next.getBoundingClientRect().top > innerHeight;
      }), 'the reader is inside Native terminal visual delivery with no heading visible');

      await page.reload();
      await expectSection(page, 'native-terminal-visual-delivery');
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await expectSection(page, '_top');
      await scrollInside(page, 'native-terminal-visual-delivery');
      await expectSection(page, 'native-terminal-visual-delivery');
      await scrollInside(page, 'post-notify');
      await expectSection(page, 'post-notify');

      const select = page.locator('[data-nb-mobile-toc-select]');
      await select.selectOption('native-terminal-visual-delivery');
      await page.waitForFunction(() => {
        const top = document.getElementById('native-terminal-visual-delivery').getBoundingClientRect().top;
        return top >= 0 && top < innerHeight / 2;
      });
      await page.waitForTimeout(1100);
      await expectSection(page, 'native-terminal-visual-delivery');

      await select.selectOption('_top');
      await page.waitForFunction(() => scrollY === 0);
      await page.waitForTimeout(1100);
      await expectSection(page, '_top');

      await select.selectOption('native-terminal-visual-delivery');
      await page.waitForFunction(() => {
        const top = document.getElementById('native-terminal-visual-delivery').getBoundingClientRect().top;
        return top >= 0 && top < innerHeight / 2;
      });
      await scrollInside(page, 'post-notify');
      await expectSection(page, 'post-notify');
      await page.setViewportSize({ width: 700, height: 600 });
      await expectSection(page, 'post-notify');
      console.log(`ok mobile TOC (${reducedMotion}): restored position, scroll directions, jumps, suppression, resize`);
    } finally {
      await context.close();
    }
  }
  console.log('PASS');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
