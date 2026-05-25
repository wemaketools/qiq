// Verify version display + commenting flow end-to-end.
const { chromium } = require('playwright');
const path = require('path');
const APP = 'file://' + path.resolve(__dirname, '../app/index.html');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.goto(APP, { waitUntil: 'networkidle' });
  await p.evaluate(() => { localStorage.setItem('qiq_seen_tour', '1'); localStorage.removeItem('qiq_comments_v1'); });
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(300);

  // version visible?
  const ver = await p.evaluate(() => ({ side: document.querySelector('.brand .ver') && document.querySelector('.brand .ver').textContent, V: window.QIQ.VERSION }));
  console.log('version chip:', ver.side, '| QIQ.VERSION:', ver.V);

  // turn on comment mode via API (same path the toggle uses)
  await p.evaluate(() => window.QIQ.feedback.setMode(true));
  await p.waitForTimeout(300);
  const barShown = await p.evaluate(() => getComputedStyle(document.getElementById('cmt-bar')).display);
  console.log('comment bar display:', barShown);

  // hover a KPI to reveal the + badge, then click it
  await p.hover('.kpi:nth-child(4)');
  await p.waitForTimeout(150);
  const hoverShown = await p.evaluate(() => document.getElementById('cmt-hover').style.display);
  console.log('hover overlay display:', hoverShown);
  await p.click('#cmt-hover .cmt-badge');
  await p.waitForTimeout(150);
  const anc = await p.evaluate(() => document.querySelector('#cmt-pop .anc') && document.querySelector('#cmt-pop .anc').textContent.trim());
  console.log('popover anchor:', anc);
  await p.fill('#cmtText', 'This KPI should be MTD, not all-time.');
  await p.click('#cmtSave');
  await p.waitForTimeout(200);

  // add a second comment on a table row
  await p.hover('table.tbl tbody tr:first-child');
  await p.waitForTimeout(120);
  await p.click('#cmt-hover .cmt-badge');
  await p.waitForTimeout(120);
  await p.fill('#cmtText', 'Can we show next-action owner here?');
  await p.click('#cmtSave');
  await p.waitForTimeout(200);

  const count = await p.evaluate(() => window.QIQ.feedback.count());
  const pins = await p.evaluate(() => document.querySelectorAll('.cmt-pin').length);
  console.log('comment count:', count, '| pins on page:', pins);

  // open panel, set reviewer, read export text (capture clipboard via override)
  await p.evaluate(() => { window.__copied = ''; navigator.clipboard.writeText = (s) => { window.__copied = s; return Promise.resolve(); }; });
  await p.evaluate(() => window.QIQ.feedback.openPanel());
  await p.fill('#cmtReviewer', 'Thomas');
  await p.dispatchEvent('#cmtReviewer', 'change');
  await p.click('#cmtCopy');
  await p.waitForTimeout(150);
  const copied = await p.evaluate(() => window.__copied);
  console.log('\n--- COPIED EXPORT ---\n' + copied + '\n---------------------');

  await p.screenshot({ path: '/tmp/qiq-shots/comment-mode.png', fullPage: false });
  console.log('\npage errors:', errs.length); errs.forEach((e) => console.log('  ' + e));
  await b.close();
})();
