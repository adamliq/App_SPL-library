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
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
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

  // The feature checks below use a temporary query that is deleted at the end,
  // so the library, its usage counts and favorites are left as they were.
  const token = `uitest${Date.now()}`;
  const title = `UI test ${token}`;
  await page.click('.sl-topbar .sl-btn-primary');
  await page.waitForTimeout(300);
  check(await active('.sl-modal'), 'add-query form focuses its first field');
  await page.mouse.click(5, 5);
  check(await page.isVisible('.sl-modal'), 'clicking outside does not close the form');
  await page.fill('.sl-modal .sl-input >> nth=0', title);
  await page.fill('.sl-modal .sl-textarea',
    `index=_internal sourcetype=splunkd ${token}\n| stats count by component\n| where count > 5`);
  await snap('light-modal');
  await page.click('.sl-modal .sl-btn-primary');
  const card = cards().filter({ hasText: title });
  check(await card.waitFor({ timeout: 15000 }).then(() => true, () => false), 'saved query appears in the list');
  const key = await card.getAttribute('data-key');
  const isOpen = async (c = card) => /\bopen\b/.test(await c.getAttribute('class'));
  const expand = async () => { if (!(await isOpen())) await card.locator('.sl-card-header').click(); };
  const hash = () => decodeURIComponent(new URL(page.url()).hash);

  // Syntax highlighting and search-match highlighting
  await expand();
  const tokens = cls => card.locator(`.sl-spl .sl-tk-${cls}`).allTextContents();
  check((await tokens('cmd')).join(',') === 'stats,where', 'SPL commands are highlighted');
  check((await tokens('fld')).includes('sourcetype'), 'SPL field names are highlighted');
  check((await tokens('kw')).includes('by'), 'SPL keywords are highlighted');
  await page.fill('.sl-search-input', token);
  await page.waitForTimeout(200);
  check((await cards().count()) === 1, 'search finds a query by a word inside its SPL');
  check((await card.locator('mark.sl-hit').count()) >= 2, 'search matches are highlighted in the title and SPL');
  await snap('light-search-highlight');

  // Shareable URL: view state is written to the URL and restored on reload
  check(hash().includes(`q=${token}`) && hash().includes(`open=${key}`), 'search and the open query are in the URL');
  await page.reload();
  await card.waitFor({ timeout: 30000 });
  check(await page.inputValue('.sl-search-input') === token, 'reloading the URL restores the search');
  check(await isOpen(), 'reloading the URL re-opens the query');
  await page.fill('.sl-search-input', '');
  await page.waitForTimeout(200);

  // Copy link, then follow it in a new tab
  await expand();
  await card.locator('.sl-btn-link').click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  check(link.endsWith(`#open=${encodeURIComponent(key)}`), 'Copy link puts a link to the query on the clipboard');
  const tab = await ctx.newPage();
  await tab.goto(link);
  const linked = tab.locator(`.sl-card.open[data-key="${key}"]`);
  check(await linked.waitFor({ timeout: 30000 }).then(() => true, () => false), 'a copied link opens the query');
  check(await linked.evaluate(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; }),
    'a copied link scrolls the query into view');
  await tab.screenshot({ path: path.join(OUT, 'linked.png') });
  await tab.goto(`${BASE}/en-US/app/spl_library/library#open=no-such-query`);
  check(await tab.locator('.sl-notice').waitFor({ timeout: 30000 }).then(() => true, () => false),
    'a link to a missing query shows a notice');
  await tab.close();

  // Favorites, saved per user in the KV Store
  const starred = async () => Number(await page.locator('.sl-cat-starred .sl-cat-count').textContent());
  const starredBefore = await starred();
  await card.locator('.sl-star').click();
  await page.waitForTimeout(300);
  check(await starred() === starredBefore + 1, 'starring a query adds it to Starred');
  await page.click('.sl-cat-starred');
  await page.waitForTimeout(200);
  check(await card.isVisible() && hash().includes('cat=Starred'), 'the Starred filter shows it and is in the URL');
  await snap('light-starred');
  await page.waitForTimeout(500);
  await page.reload();
  await card.waitFor({ timeout: 30000 });
  check(/\bon\b/.test(await card.locator('.sl-star').getAttribute('class')), 'stars survive a reload');
  await page.locator('.sl-cat-btn').first().click();

  // Usage counts and sorting
  await expand();
  await card.locator('.sl-btn-copy').click();
  await card.locator('.sl-btn-copy').click();
  check((await card.locator('.sl-uses').textContent()) === '2 uses', 'copying the SPL counts as a use');
  await page.selectOption('.sl-sort-select', 'used');
  await page.waitForTimeout(200);
  check(await cards().first().getAttribute('data-key') === key, 'Most used puts the most-copied query first');
  await page.selectOption('.sl-sort-select', 'title');
  await page.waitForTimeout(200);
  const titles = await page.locator('.sl-card-title').allTextContents();
  const sorted = [...titles].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  check(JSON.stringify(titles) === JSON.stringify(sorted), 'Title sort orders queries A to Z');
  await page.reload();
  await card.waitFor({ timeout: 30000 });
  check(await page.inputValue('.sl-sort-select') === 'title', 'the sort order is restored from the URL');
  await page.selectOption('.sl-sort-select', 'newest');

  // Deleting the query also removes its usage count and its star
  await expand();
  await card.locator('.sl-btn-delete').click();
  check(await card.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false),
    'deleted query disappears from the list');
  await page.waitForTimeout(1000);
  const kvGet = (coll, k) => page.evaluate(async ([coll, k]) => {
    const r = await fetch(`/en-US/splunkd/__raw/servicesNS/nobody/spl_library/storage/collections/data/${coll}/${encodeURIComponent(k)}?output_mode=json`);
    return { status: r.status, body: r.ok ? await r.json() : null };
  }, [coll, k]);
  check((await kvGet('spl_library_usage', key)).status === 404, 'deleting a query removes its usage count');
  const fav = await kvGet('spl_library_favorites', USER);
  check(!(fav.body && (fav.body.keys || []).includes(key)), 'deleting a query removes it from favorites');
  check(await starred() === starredBefore, 'Starred count is back to where it started');

  await page.click('.sl-btn-theme');
  check(pageErrors.length === 0, 'no JavaScript errors' + (pageErrors.length ? ': ' + pageErrors.join('; ') : ''));
  await browser.close();

  console.log(`\n${failures.length ? failures.length + ' check(s) failed' : 'all checks passed'}; screenshots in ${OUT}`);
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
