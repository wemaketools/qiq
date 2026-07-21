// Verify the mobile "Show more" reveals rows.
const { chromium } = require('playwright');
const path = require('path');
const APP = 'file://' + path.resolve(__dirname, '../app/index.html');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto(APP, { waitUntil: 'networkidle' });
  await p.evaluate(() => localStorage.setItem('qiq_seen_tour', '1'));
  await p.setViewportSize({ width: 390, height: 844 });
  await p.reload({ waitUntil: 'networkidle' });
  await p.evaluate(() => { location.hash = '#/pipeline'; });
  await p.waitForTimeout(500);
  const visible = () => p.evaluate(() => Array.from(document.querySelectorAll('table.tbl tbody tr')).filter((r) => r.offsetParent !== null).length);
  const before = await visible();
  await p.click('[data-showmore]');
  await p.waitForTimeout(150);
  const after = await visible();
  const btnText = await p.evaluate(() => { const b = document.querySelector('[data-showmore]'); return b ? b.textContent.trim() : '(button removed)'; });
  // click a quote card to verify navigation still works
  await p.click('table.tbl tbody tr');
  await p.waitForTimeout(300);
  const hash = await p.evaluate(() => location.hash);
  console.log('visible before:', before, '| after one click:', after, '| button now:', btnText);
  console.log('row click → hash:', hash);
  await b.close();
})();
