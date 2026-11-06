import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { serveDist } from './serve-dist.mjs';

const backgrounds = { dark: [11, 17, 19], light: [246, 245, 241] };
const { server, base } = await serveDist();
let browser;

function measure(focusOnly = false) {
  const parse = (value) => {
    const parts = value.match(/[\d.]+/g).map(Number);
    return { rgb: parts.slice(0, 3), alpha: parts[3] ?? 1 };
  };
  const over = (fg, bg) => fg.rgb.map((v, i) => v * fg.alpha + bg[i] * (1 - fg.alpha));
  const background = (el) => {
    const ancestors = [];
    for (; el; el = el.parentElement) ancestors.unshift(el);
    return ancestors.reduce((bg, node) => over(parse(getComputedStyle(node).backgroundColor), bg), [255, 255, 255]);
  };
  const luminance = (rgb) => rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) => {
    const x = luminance(a);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const rows = [];

  if (focusOnly) {
    const el = document.activeElement;
    const style = getComputedStyle(el);
    const bg = background(el.parentElement);
    const visible = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
    rows.push({ label: `focus: ${el.textContent.trim() || el.getAttribute('aria-label')}`, min: 3,
      ratio: visible ? contrast(over(parse(style.outlineColor), bg), bg) : 0 });
  } else {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      const el = text.parentElement;
      if (!text.textContent.trim() || el.closest('script, style, .sr, .skip, [aria-hidden="true"]') || !el.checkVisibility()) continue;
      const style = getComputedStyle(el);
      const bg = background(el);
      const color = parse(style.color);
      const colors = color.alpha === 0 && style.backgroundClip === 'text'
        ? (style.backgroundImage.match(/rgba?\([^)]+\)/g) || []).map(parse)
        : [color];
      rows.push({ label: text.textContent.trim(), min: 4.5,
        ratio: colors.length ? Math.min(...colors.map((fg) => contrast(over(fg, bg), bg))) : 0 });
    }
    for (const el of document.querySelectorAll('.node')) {
      const bg = background(el.parentElement);
      rows.push({ label: `step border: ${el.textContent}`, min: 3,
        ratio: contrast(over(parse(getComputedStyle(el).borderTopColor), bg), bg) });
    }
  }

  return { background: parse(getComputedStyle(document.documentElement).backgroundColor).rgb, rows };
}

try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  for (const system of ['light', 'dark']) {
    for (const javaScriptEnabled of [true, false]) {
      for (const saved of [null, system === 'light' ? 'dark' : 'light']) {
        const expected = javaScriptEnabled && saved ? saved : system;
        const context = await browser.newContext({ colorScheme: system, javaScriptEnabled, reducedMotion: 'reduce',
          viewport: { width: 1280, height: 800 },
          storageState: { cookies: [], origins: [{ origin: base,
            localStorage: saved ? [{ name: 'echo-theme', value: saved }] : [] }] } });
        try {
          const page = await context.newPage();
          await page.goto(base, { waitUntil: 'load' });
          const label = `system=${system} saved=${saved || 'none'} js=${javaScriptEnabled}`;
          const result = await page.evaluate(measure);
          assert.deepEqual(result.background, backgrounds[expected], `${label}: rendered theme`);
          assert.ok(result.rows.length > 0, `${label}: rendered content`);
          const controls = await page.locator('a[href], button').count();
          for (let i = 0; i < controls; i++) {
            await page.keyboard.press('Tab');
            result.rows.push(...(await page.evaluate(measure, true)).rows);
          }
          const failures = result.rows.filter((row) => !Number.isFinite(row.ratio) || row.ratio < row.min);
          assert.deepEqual(failures, [], `${label}: WCAG 2.2 text 4.5:1 and indicators 3:1`);
          console.log(`ok ${label}: ${result.rows.length} rendered contrast checks`);
        } finally {
          await context.close();
        }
      }
    }
  }
  console.log('PASS');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
