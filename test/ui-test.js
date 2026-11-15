// End-to-end check of the SPL Library dashboard in a running Splunk.
// Exits non-zero if any check fails; screenshots go to OUT_DIR.
//
// Env: SPLUNK_URL (http://localhost:8000), SPLUNK_USER (admin),
//      SPLUNK_PASSWORD (Changeme123!), OUT_DIR (test/screenshots),
//      CHROMIUM_PATH (optional: use this Chromium instead of Playwright's)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.SPLUNK_URL || 'http://localhost:8000';
const USER = process.env.SPLUNK_USER || 'admin';
const PASSWORD = process.env.SPLUNK_PASSWORD || 'Changeme123!';
const OUT = process.env.OUT_DIR || path.join(__dirname, 'screenshots');

const failures = [];
function check(ok, what) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('dialog', d => d.accept());
  const snap = name => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const cards = () => page.locator('#spl-library-root .sl-card');
  const active = sel => page.evaluate(s => !!document.activeElement.closest(s), sel);

  await page.goto(`${BASE}/en-US/account/login`);
  await page.fill('#username', USER);
  await page.fill('#password', PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('input[type=submit]')]);

  // On a fresh Splunk the KV Store may still be starting, so retry the first load
  let loaded = false;
  for (let attempt = 0; attempt < 6 && !loaded; attempt++) {
    await page.goto(`${BASE}/en-US/app/spl_library/library`);
    loaded = await page.waitForSelector('#spl-library-root .sl-card', { timeout: 30000 })
      .then(() => true, () => false);
  }
  check(loaded, 'library loads and shows queries');
  if (!loaded) { await snap('load-failed'); throw new Error('library never loaded'); }
  const total = await cards().count();

  check(!(await page.isVisible('.dashboard-header')), "Splunk's duplicate dashboard title is hidden");
  await snap('dark');

  await page.mouse.click(5, 5);
  await page.keyboard.press('/');
  check(await active('.sl-search-input'), '"/" focuses the search box');
  await page.keyboard.type('dns');
  await page.waitForTimeout(200);
  check((await cards().count()) < total, 'typing in search filters the list');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check((await cards().count()) === total, 'Escape clears the search');

  await page.focus('.sl-card-header');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  check((await page.locator('.sl-card.open').count()) === 1, 'Enter expands a card');
  check(await active('.sl-card-header'), 'focus stays on the card after expanding');
  await snap('dark-expanded');

  await page.click('.sl-btn-theme');
  await page.waitForTimeout(300);
  check(await page.getAttribute('#spl-library-root', 'data-theme') === 'light', 'theme toggle switches to light');
  await snap('light');

  // Splunk pins <body> at min-width 960px, so narrow the panel directly
  await page.evaluate(() => { document.getElementById('spl-library-root').style.width = '480px'; });
  await page.waitForTimeout(300);
  const dir = await page.evaluate(() => getComputedStyle(document.querySelector('.sl-sidebar')).flexDirection);
  check(dir === 'row', 'narrow panel turns categories into a chip row');
  await page.locator('#spl-library-root').screenshot({ path: path.join(OUT, 'light-narrow.png') });
  await page.evaluate(() => { document.getElementById('spl-library-root').style.width = ''; });

  // Add a query, then delete it again, so the test leaves the library as it found it
  const title = `UI test ${Date.now()}`;
  await page.click('.sl-topbar .sl-btn-primary');
  await page.waitForTimeout(300);
  check(await active('.sl-modal'), 'add-query form focuses its first field');
  await page.mouse.click(5, 5);
  check(await page.isVisible('.sl-modal'), 'clicking outside does not close the form');
  await page.fill('.sl-modal .sl-input >> nth=0', title);
  await page.fill('.sl-modal .sl-textarea', 'index=_internal | head 1');
  await snap('light-modal');
  await page.click('.sl-modal .sl-btn-primary');
  const card = cards().filter({ hasText: title });
  check(await card.waitFor({ timeout: 15000 }).then(() => true, () => false), 'saved query appears in the list');
  await card.locator('.sl-card-header').click();
  await card.locator('.sl-btn-delete').click();
  check(await card.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false),
    'deleted query disappears from the list');

  await page.click('.sl-btn-theme');
  check(pageErrors.length === 0, 'no JavaScript errors' + (pageErrors.length ? ': ' + pageErrors.join('; ') : ''));
  await browser.close();

  console.log(`\n${failures.length ? failures.length + ' check(s) failed' : 'all checks passed'}; screenshots in ${OUT}`);
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
