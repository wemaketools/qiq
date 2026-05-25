// Playwright driver: screenshot QuoteIQ across routes & breakpoints, log console errors.
// Run: bun tools/shoot.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const APP = 'file://' + path.resolve(__dirname, '../app/index.html');
const OUT = '/tmp/qiq-shots';
fs.mkdirSync(OUT, { recursive: true });

const ROUTES = [
  ['overview', 'overview'],
  ['pipeline', 'pipeline'],
  ['pipeline-conv', 'pipeline/conversion'],
  ['brokers', 'brokers'],
  ['rm', 'rm'],
  ['loss', 'loss'],
  ['alerts', 'alerts'],
  ['reports', 'reports'],
  ['quote', 'quote/Q-2025-1000'],
];
const VIEWPORTS = [
  ['desktop', 1440, 900],
  ['laptop', 1180, 800],
  ['ipad', 1024, 1366],
  ['tablet', 820, 1100],
  ['mobile', 390, 844],
];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  // set the "seen tour" flag, then reload so the tour never opens
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.setItem('qiq_seen_tour', '1'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  const only = process.argv[2]; // optional route filter
  const vpOnly = process.argv[3]; // optional viewport filter

  for (const [vname, w, h] of VIEWPORTS) {
    if (vpOnly && vname !== vpOnly) continue;
    await page.setViewportSize({ width: w, height: h });
    for (const [rname, hash] of ROUTES) {
      if (only && rname !== only) continue;
      await page.evaluate((hh) => { location.hash = '#/' + hh; }, hash);
      await page.waitForTimeout(550); // allow render + chart layout
      const file = `${OUT}/${rname}__${vname}.png`;
      await page.screenshot({ path: file, fullPage: true });
    }
  }

  // resize stress test: load conversion at wide then shrink, screenshot mid-shrink
  await page.evaluate(() => { location.hash = '#/pipeline/conversion'; });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  await page.setViewportSize({ width: 1000, height: 820 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/RESIZE_conv_1000.png`, fullPage: true });

  await browser.close();
  console.log('shots written to', OUT);
  console.log('console errors:', errors.length);
  errors.slice(0, 40).forEach((e) => console.log('  ' + e));
})();
