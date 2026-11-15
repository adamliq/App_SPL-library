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
  let dialogs = 0;
  page.on('dialog', d => { dialogs++; d.accept(); });
  const snap = name => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const cards = () => page.locator('#spl-library-root .sl-card');
  const active = sel => page.evaluate(s => !!document.activeElement.closest(s), sel);
  const hash = () => decodeURIComponent(new URL(page.url()).hash);

  await page.goto(`${BASE}/en-US/account/login`);
  await page.fill('#username', USER);
  await page.fill('#password', PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('input[type=submit]')]);

  // Splunk caches app static files under a versioned URL and can keep serving an
  // old library.js; bumping the version makes it serve the files on disk
  await page.goto(`${BASE}/en-US/_bump`);
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

  // Clicking a tag filters to queries with that tag; the filter is in the URL
  await page.locator('.sl-tag-btn', { hasText: /^security$/ }).first().click();
  await page.waitForTimeout(200);
  const tagSets = await cards().evaluateAll(cs => cs.map(c => [...c.querySelectorAll('.sl-tag-btn')].map(t => t.textContent)));
  check(tagSets.length > 0 && tagSets.length < total && tagSets.every(ts => ts.includes('security')),
    'clicking a tag shows only queries with that tag');
  check(hash().includes('tag=security'), 'the tag filter is in the URL');
  await snap('light-tag-filter');
  await page.click('.sl-tag-filter');
  await page.waitForTimeout(200);
  check((await cards().count()) === total, 'removing the tag chip clears the filter');

  // Long SPL lines wrap by default; turning wrapping off is remembered
  const longCard = cards().filter({ hasText: 'Microsoft 365' });
  if (!/\bopen\b/.test(await longCard.getAttribute('class'))) await longCard.locator('.sl-card-header').click();
  const narrowRoot = w => page.evaluate(w => { document.getElementById('spl-library-root').style.width = w; }, w);
  const splFits = () => longCard.locator('.sl-spl').evaluate(e => e.scrollWidth <= e.clientWidth + 1);
  await narrowRoot('560px');
  check(await splFits(), 'long SPL lines wrap by default');
  await page.uncheck('.sl-wrap-toggle input');
  check(!(await splFits()), 'turning wrapping off keeps long lines on one line');
  await page.reload();
  await longCard.waitFor({ timeout: 30000 });
  check(!(await page.isChecked('.sl-wrap-toggle input')), 'the wrap setting is remembered');
  await page.check('.sl-wrap-toggle input');
  await narrowRoot('');

  // The top bar and sidebar stay in view while scrolling a long list
  await cards().last().scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(300);
  const pos = await page.evaluate(() => {
    const top = s => document.querySelector(s).getBoundingClientRect();
    return { root: top('#spl-library-root').top, bar: top('.sl-topbar'), side: top('.sl-sidebar') };
  });
  check(pos.root < -50, 'the page scrolled past the top of the app');
  check(pos.bar.top >= 0 && pos.bar.top <= 60, 'the top bar stays at the top while scrolling');
  check(pos.side.top >= pos.bar.bottom && pos.side.top <= pos.bar.bottom + 40, 'the sidebar stays in view below the top bar');
  await snap('light-sticky');
  await page.evaluate(() => window.scrollTo(0, 0));

  // Compact view: collapsed queries become one-line rows; the choice is remembered
  await page.click('.sl-view-btn[data-view="compact"]');
  await page.waitForTimeout(200);
  const rowHeights = await cards().evaluateAll(cs =>
    cs.filter(c => !c.classList.contains('open')).map(c => c.getBoundingClientRect().height));
  check(rowHeights.length > 0 && rowHeights.every(h => h < 50), 'compact view shows one-line rows');
  check(await page.locator('#sl-main .sl-card:not(.open) .sl-card-desc').first().isHidden(),
    'compact rows hide the description');
  await snap('light-compact');
  await page.reload();
  await cards().first().waitFor({ timeout: 30000 });
  check(await page.getAttribute('.sl-view-btn[data-view="compact"]', 'aria-pressed') === 'true',
    'compact view is remembered after a reload');
  await page.click('.sl-view-btn[data-view="cards"]');

  // Escape and Tab in dialogs, and focus returning to the button that opened them
  const addButton = '.sl-topbar .sl-btn-primary';
  await page.click(addButton);
  await page.keyboard.press('Escape');
  check(!(await page.isVisible('.sl-modal')), 'Escape closes an untouched form');
  check(await active('.sl-topbar'), 'closing the form returns focus to "+ Add query"');
  await page.click(addButton);
  await page.fill('.sl-modal .sl-input >> nth=0', 'draft');
  await page.keyboard.press('Escape');
  check(await page.isVisible('.sl-modal .sl-discard'), 'Escape with changes asks before discarding');
  await page.keyboard.press('Escape');
  check(!(await page.isVisible('.sl-modal .sl-discard')) &&
    await page.inputValue('.sl-modal .sl-input >> nth=0') === 'draft', 'Escape on that prompt keeps editing');
  await page.focus('.sl-modal .sl-btn-primary');
  await page.keyboard.press('Tab');
  check(await active('.sl-modal') && await page.evaluate(() => document.activeElement.classList.contains('sl-input')),
    'Tab from the last button wraps to the first field');
  await page.keyboard.press('Shift+Tab');
  check(await page.evaluate(() => document.activeElement.classList.contains('sl-btn-primary')),
    'Shift+Tab from the first field wraps to the last button');
  await page.mouse.click(5, 5);
  await page.keyboard.press('Tab');
  check(await active('.sl-modal'), 'Tab cannot move focus behind the dialog');
  await page.keyboard.press('Escape');
  await page.click('.sl-btn-discard');

  // Splunk's app menu: Starred and Add query links, and the app's own icon
  const navStarred = page.locator('a[href="library#cat=Starred"]');
  const navAdd = page.locator('a[href="library#new"]');
  check(await navStarred.count() > 0 && await navAdd.count() > 0, "Splunk's app menu has Starred and Add query");
  await navStarred.first().click();
  await page.waitForTimeout(400);
  check(await page.getAttribute('.sl-cat-starred', 'aria-pressed') === 'true', 'the Starred menu link opens the Starred filter');
  await navAdd.first().click();
  check(await page.locator('.sl-modal').waitFor({ timeout: 5000 }).then(() => true, () => false),
    'the Add query menu link opens the add form');
  await page.keyboard.press('Escape');
  await page.locator('.sl-cat-btn').first().click();
  const servedIcon = await page.evaluate(async () => {
    const r = await fetch('/en-US/splunkd/__raw/servicesNS/nobody/spl_library/static/appIcon.png');
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin);
  });
  const ownIcon = fs.readFileSync(path.join(__dirname, '..', 'spl_library', 'static', 'appIcon.png')).toString('base64');
  check(servedIcon === ownIcon, 'Splunk serves the app’s own icon, not its default badge');

  // Cancel asks before throwing away a draft
  await page.click('.sl-topbar .sl-btn-primary');
  await page.click('.sl-modal .sl-btn-cancel');
  check(!(await page.isVisible('.sl-modal')), 'Cancel closes an untouched form straight away');
  await page.click('.sl-topbar .sl-btn-primary');
  await page.fill('.sl-modal .sl-input >> nth=0', 'draft title');
  await page.click('.sl-modal .sl-btn-cancel');
  check(await page.isVisible('.sl-modal .sl-discard'), 'Cancel with changes asks before discarding');
  await snap('light-discard');
  await page.click('.sl-discard-keep');
  check(await page.inputValue('.sl-modal .sl-input >> nth=0') === 'draft title', 'Keep editing returns to the draft');
  await page.click('.sl-modal .sl-btn-cancel');
  await page.click('.sl-btn-discard');
  check(!(await page.isVisible('.sl-modal')), 'Discard closes the form');

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
  check(await page.locator('.sl-toast', { hasText: 'Query added' }).isVisible(), 'a notification confirms the new query');
  const key = await card.getAttribute('data-key');
  const menuAction = async (c, item) => { await c.locator('.sl-more').click(); await page.click(`.sl-menu ${item}`); };
  const kvGet = (coll, k) => page.evaluate(async ([coll, k]) => {
    const r = await fetch(`/en-US/splunkd/__raw/servicesNS/nobody/spl_library/storage/collections/data/${coll}/${encodeURIComponent(k)}?output_mode=json`);
    return { status: r.status, body: r.ok ? await r.json() : null };
  }, [coll, k]);
  const isOpen = async (c = card) => /\bopen\b/.test(await c.getAttribute('class'));
  const expand = async () => { if (!(await isOpen())) await card.locator('.sl-card-header').click(); };

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
  await menuAction(card, '.sl-menu-link');
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

  // More menu: four actions, arrow keys, Escape, clicking elsewhere
  await expand();
  const moreBtn = card.locator('.sl-more');
  await moreBtn.click();
  check(await page.locator('.sl-menu .sl-menu-item').count() === 4, 'the More menu lists Copy link, Duplicate, Edit and Delete');
  check(await page.evaluate(() => document.activeElement.classList.contains('sl-menu-link')), 'opening the menu focuses its first item');
  await page.keyboard.press('ArrowDown');
  check(await page.evaluate(() => document.activeElement.classList.contains('sl-menu-duplicate')), 'arrow keys move through the menu');
  await snap('light-menu');
  await page.keyboard.press('Escape');
  check(!(await page.isVisible('.sl-menu')) && await page.evaluate(() => document.activeElement.classList.contains('sl-more')),
    'Escape closes the menu and returns focus to the ⋯ button');
  await moreBtn.click();
  await page.mouse.click(5, 5);
  check(!(await page.isVisible('.sl-menu')), 'clicking elsewhere closes the menu');

  // Duplicate, and the live SPL preview in the form
  await menuAction(card, '.sl-menu-duplicate');
  check(await page.inputValue('.sl-modal .sl-input >> nth=0') === `Copy of ${title}` &&
    (await page.inputValue('.sl-modal .sl-textarea')).includes(token), 'Duplicate opens the add form pre-filled');
  const previewCmds = () => page.locator('.sl-form-preview .sl-tk-cmd').allTextContents();
  check((await previewCmds()).join(',') === 'stats,where', 'the form previews the SPL with syntax highlighting');
  await page.fill('.sl-modal .sl-textarea', 'index=main | timechart count');
  check((await previewCmds()).join(',') === 'timechart', 'the preview updates while typing');
  await snap('light-form-preview');
  await page.keyboard.press('Escape');
  await page.click('.sl-btn-discard');

  // Edit history: who last edited a query, and when
  await menuAction(card, '.sl-menu-edit');
  await page.fill('.sl-modal .sl-input >> nth=1', 'edited by the UI test');
  await page.click('.sl-modal .sl-btn-primary');
  check(await page.locator('.sl-toast', { hasText: 'Query saved' }).waitFor({ timeout: 15000 }).then(() => true, () => false),
    'a notification confirms the edit');
  check(await page.evaluate(() => document.activeElement.classList.contains('sl-more')), 'saving returns focus to the ⋯ button');
  await expand();
  check(new RegExp(`Edited today by ${USER}`).test(await card.locator('.sl-meta-text').textContent()),
    'the card shows who last edited it and when');
  check(((await kvGet('spl_library_queries', key)).body || {}).updated_by === USER, 'the editor is saved with the query');

  // Mine and Popular tags match what is stored
  const stored = await page.evaluate(async () => (await (await fetch(
    '/en-US/splunkd/__raw/servicesNS/nobody/spl_library/storage/collections/data/spl_library_queries?output_mode=json')).json()));
  const mine = stored.filter(q => q.author === USER).length;
  check(Number(await page.textContent('.sl-cat-mine .sl-cat-count')) === mine, 'the Mine count matches the queries you added');
  await page.click('.sl-cat-mine');
  await page.waitForTimeout(200);
  check((await cards().count()) === mine && await card.isVisible() && hash().includes('cat=Mine'),
    'the Mine filter shows exactly your queries');
  await page.locator('.sl-cat-btn').first().click();
  const tagCounts = {};
  stored.forEach(q => [...new Set(String(q.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean))]
    .forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const top = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a] || a.localeCompare(b))[0];
  const firstTag = page.locator('.sl-side-tag').first();
  check((await firstTag.textContent()) === `${top}${tagCounts[top]}`, `the most-used tag (${top}) heads Popular tags with its count`);
  await firstTag.click();
  await page.waitForTimeout(200);
  check((await cards().count()) === tagCounts[top] && await page.isVisible('.sl-tag-filter'),
    'clicking a popular tag filters by it');
  await snap('light-popular-tag');
  await page.locator('.sl-side-tag').first().click();
  await page.waitForTimeout(200);
  check(!(await page.isVisible('.sl-tag-filter')), 'clicking it again clears the filter');

  // Deleting the query also removes its usage count and its star
  await expand();
  await menuAction(card, '.sl-menu-delete');
  check(await card.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false),
    'deleted query disappears from the list');
  await page.waitForTimeout(1000);
  check((await kvGet('spl_library_usage', key)).status === 404, 'deleting a query removes its usage count');
  const fav = await kvGet('spl_library_favorites', USER);
  check(!(fav.body && (fav.body.keys || []).includes(key)), 'deleting a query removes it from favorites');
  check(await starred() === starredBefore, 'Starred count is back to where it started');
  // Undo brings the query back with the same key, use count and star
  check(await page.locator('.sl-toast', { hasText: 'Deleted' }).isVisible(), 'deleting shows a notification with Undo');
  await page.screenshot({ path: path.join(OUT, 'light-undo.png') });
  await page.click('.sl-toast-action');
  check(await card.waitFor({ timeout: 15000 }).then(() => true, () => false) &&
    await card.getAttribute('data-key') === key, 'Undo restores the query under the same key');
  await page.waitForTimeout(1000);
  check((await kvGet('spl_library_queries', key)).status === 200, 'the restored query is saved');
  check(Number(((await kvGet('spl_library_usage', key)).body || {}).count) === 2, 'Undo restores its use count');
  const favBack = await kvGet('spl_library_favorites', USER);
  check(!!(favBack.body && (favBack.body.keys || []).includes(key)), 'Undo restores its star');
  check(await page.locator('.sl-toast', { hasText: 'restored' }).isVisible(), 'a notification confirms the restore');

  // Delete it again for good
  await expand();
  await menuAction(card, '.sl-menu-delete');
  check(await card.waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false),
    'the query can be deleted again');
  await page.waitForTimeout(1000);
  check(dialogs === 0, 'no browser confirm popups were used');

  // Loading: placeholders while waiting, and automatic retries while the KV Store starts
  {
    const queriesGet = /storage\/collections\/data\/spl_library_queries\?output_mode/;
    const tab = await ctx.newPage();
    let refused = 0;
    await tab.route(queriesGet, route => {
      if (route.request().method() === 'GET' && refused < 2) {
        refused++;
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      }
      return route.continue();
    });
    await tab.goto(`${BASE}/en-US/app/spl_library/library`);
    check(await tab.locator('.sl-sk-card').first().waitFor({ timeout: 30000 }).then(() => true, () => false),
      'placeholder cards show while the library loads');
    check(await tab.locator('.sl-retry-notice').waitFor({ timeout: 15000 }).then(() => true, () => false),
      'a temporary KV Store error shows a retry notice');
    await tab.screenshot({ path: path.join(OUT, 'loading-retry.png') });
    check(await tab.locator('.sl-card').first().waitFor({ timeout: 30000 }).then(() => true, () => false) && refused === 2,
      'the library loads by itself once the KV Store answers');
    await tab.unroute(queriesGet);
    let blocked = true;
    await tab.route(queriesGet, route => (blocked && route.request().method() === 'GET')
      ? route.fulfill({ status: 403, contentType: 'application/json', body: '{}' }) : route.continue());
    await tab.reload();
    check(await tab.locator('.sl-btn-retry').waitFor({ timeout: 30000 }).then(() => true, () => false),
      'a permanent error offers Try again instead of retrying');
    blocked = false;
    await tab.click('.sl-btn-retry');
    check(await tab.locator('.sl-card').first().waitFor({ timeout: 30000 }).then(() => true, () => false),
      'Try again reloads the library');
    await tab.close();
  }

  // Categories: admins can add, recolor, rename, reorder and delete them
  const t = Date.now();
  const cat1 = `CLI ${t}`, cat2 = `Ops ${t}`;
  const catNames = () => page.$$eval('.sl-cat-name', els => els.map(e => e.value));
  const sidebarCats = () => page.locator('.sl-cat-btn .sl-cat-left').allTextContents();
  const saveCats = async () => { await page.click('.sl-cat-modal .sl-btn-primary'); await page.waitForTimeout(800); };
  check(await page.isVisible('.sl-side-manage'), 'admins see the Manage categories button');
  await page.click('.sl-side-manage');
  await page.click('.sl-cat-add');
  let names = await catNames();
  const newRow = names.length - 2;
  await page.fill(`.sl-cat-row >> nth=${newRow} >> .sl-cat-name`, 'security');
  await saveCats();
  check(/two categories/.test(await page.textContent('.sl-cat-modal .sl-form-error') || ''),
    'a duplicate category name is refused');
  await page.fill(`.sl-cat-row >> nth=${newRow} >> .sl-cat-name`, cat1);
  await page.selectOption(`.sl-cat-row >> nth=${newRow} >> .sl-cat-color`, 'pink');
  await page.screenshot({ path: path.join(OUT, 'light-categories.png') });
  await saveCats();
  check(!(await page.isVisible('.sl-cat-modal')) && (await sidebarCats()).includes(cat1),
    'a new category appears in the sidebar');

  // Put a temporary query in it
  const catQuery = `Category test ${t}`;
  await page.click('.sl-topbar .sl-btn-primary');
  await page.fill('.sl-modal .sl-input >> nth=0', catQuery);
  await page.selectOption('.sl-modal .sl-select', cat1);
  await page.fill('.sl-modal .sl-textarea', 'index=_internal | head 1');
  await page.click('.sl-modal .sl-btn-primary');
  const catCard = cards().filter({ hasText: catQuery });
  await catCard.waitFor({ timeout: 15000 });
  const catKey = await catCard.getAttribute('data-key');
  const storedCategory = () => page.evaluate(async k => {
    const r = await fetch(`/en-US/splunkd/__raw/servicesNS/nobody/spl_library/storage/collections/data/spl_library_queries/${k}?output_mode=json`);
    return (await r.json()).category;
  }, catKey);
  check((await catCard.locator('.sl-badge').textContent()) === cat1, 'queries can be filed under the new category');

  // Rename it and move it up one place
  await page.click('.sl-side-manage');
  names = await catNames();
  let idx = names.indexOf(cat1);
  await page.fill(`.sl-cat-row >> nth=${idx} >> .sl-cat-name`, cat2);
  await page.click(`.sl-cat-row >> nth=${idx} >> .sl-cat-move >> nth=0`);
  await saveCats();
  const order = await sidebarCats();
  check(order.includes(cat2) && !order.includes(cat1), 'renaming a category updates the sidebar');
  // The sidebar lists All, Starred and Mine before the categories
  check(order.indexOf(cat2) === idx + 3 - 1, 'moving a category up changes the sidebar order');
  check((await catCard.locator('.sl-badge').textContent()) === cat2 && await storedCategory() === cat2,
    'renaming a category moves its queries along with it');
  await page.reload();
  await catCard.waitFor({ timeout: 30000 });
  check((await sidebarCats()).includes(cat2), 'category changes are saved');

  // Delete it: its query falls back to Other
  await page.click('.sl-side-manage');
  idx = (await catNames()).indexOf(cat2);
  await page.click(`.sl-cat-row >> nth=${idx} >> .sl-cat-delete`);
  await saveCats();
  check(!(await sidebarCats()).includes(cat2), 'a deleted category leaves the sidebar');
  check((await catCard.locator('.sl-badge').textContent()) === 'Other' && await storedCategory() === 'Other',
    'queries in a deleted category move to Other');
  check(await page.isDisabled('.sl-side-manage') === false, 'Manage stays available');
  await page.click('.sl-side-manage');
  const otherRow = (await catNames()).indexOf('Other');
  check(await page.isDisabled(`.sl-cat-row >> nth=${otherRow} >> .sl-cat-delete`), 'Other cannot be deleted');
  await page.click('.sl-cat-modal .sl-btn-cancel');
  if (!/\bopen\b/.test(await catCard.getAttribute('class'))) await catCard.locator('.sl-card-header').click();
  await menuAction(catCard, '.sl-menu-delete');
  await catCard.waitFor({ state: 'detached', timeout: 15000 });

  // Users without write access to categories never see Manage, and Splunk refuses their writes
  const user = `uitest_${t}`, userPw = 'UiTest-Passw0rd!';
  const rest = (method, url, form) => page.evaluate(async ([method, url, form]) => {
    const csrf = (document.cookie.match(/splunkweb_csrf_token_[^=]*=([^;]+)/) || [])[1] || '';
    const r = await fetch(url, { method, body: form || undefined, headers: {
      'X-Splunk-Form-Key': decodeURIComponent(csrf), 'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded' } });
    return r.status;
  }, [method, url, form]);
  const created = await rest('POST', '/en-US/splunkd/__raw/services/authentication/users',
    `name=${user}&password=${encodeURIComponent(userPw)}&roles=user&force-change-pass=0`);
  check(created === 201, 'created a temporary non-admin user');
  {
    const userCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const up = await userCtx.newPage();
    await up.goto(`${BASE}/en-US/account/login`);
    await up.fill('#username', user);
    await up.fill('#password', userPw);
    await Promise.all([up.waitForNavigation(), up.click('input[type=submit]')]);
    await up.goto(`${BASE}/en-US/app/spl_library/library`);
    const ok = await up.locator('.sl-card').first().waitFor({ timeout: 60000 }).then(() => true, () => false);
    check(ok && !(await up.isVisible('.sl-side-manage')), 'users without write access do not see Manage');
    const status = await up.evaluate(async () => {
      const csrf = (document.cookie.match(/splunkweb_csrf_token_[^=]*=([^;]+)/) || [])[1] || '';
      const r = await fetch('/en-US/splunkd/__raw/servicesNS/nobody/spl_library/storage/collections/data/spl_library_categories/batch_save?output_mode=json', {
        method: 'POST', body: JSON.stringify([{ _key: 'other', name: 'Hacked', color: 'red', order: 0 }]),
        headers: { 'Content-Type': 'application/json', 'X-Splunk-Form-Key': decodeURIComponent(csrf), 'X-Requested-With': 'XMLHttpRequest' } });
      return r.status;
    });
    check(status === 403, `Splunk refuses category changes from those users (HTTP ${status})`);
    await userCtx.close();
  }
  check(await rest('DELETE', `/en-US/splunkd/__raw/services/authentication/users/${user}`) === 200,
    'removed the temporary user');

  await page.click('.sl-btn-theme');
  check(pageErrors.length === 0, 'no JavaScript errors' + (pageErrors.length ? ': ' + pageErrors.join('; ') : ''));
  await browser.close();

  console.log(`\n${failures.length ? failures.length + ' check(s) failed' : 'all checks passed'}; screenshots in ${OUT}`);
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
