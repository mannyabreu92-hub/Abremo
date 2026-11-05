// End-to-end test of the beta launch kit: the welcome card and tour (shown once), the artist page
// (#join) and the share card. Needs a running server (npm start) and Playwright.
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const BASE = process.argv[2] || 'http://localhost:5173/';
const mock = readFileSync(path.join(__dirname, 'mock-cloud.js'), 'utf8');
const PHOTO = path.join(__dirname, '..', '..', 'icons', 'screenshot-wide.jpg');
const step = (name) => console.log(`✓ ${name}`);

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && errors.push(m.text())); return p; };

  // ——— Welcome card and tour, once ———
  const guest = watch(await browser.newPage({ viewport: { width: 390, height: 844 } }));
  await guest.goto(BASE + '#home');
  await guest.waitForSelector('.welcome-card');
  await guest.click('[data-act=tour-open]');
  await guest.waitForSelector('.tour');
  assert.match(await guest.locator('.tour').textContent(), /1 of 3.*Pass.*Admire.*Treasure/s);
  await guest.click('[data-act=tour-next]');
  await guest.click('[data-act=tour-next]');
  assert.match(await guest.locator('.tour').textContent(), /3 of 3/);
  await guest.click('[data-act=tour-done]');
  await guest.waitForFunction(() => location.hash === '#discover');
  await guest.goto(BASE + '#home');
  await guest.reload();
  await guest.waitForSelector('#view .shell');
  assert.equal(await guest.locator('.welcome-card').count(), 0, 'shown once');
  assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth), 390);
  step('first-time visitors get a skippable 3-step tour, shown once');

  // ——— The artist page ———
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(mock);
  const visitor = watch(await ctx.newPage());
  await visitor.goto(BASE + '#join');
  await visitor.waitForSelector('.join-page');
  const text = await visitor.locator('.join-page').textContent();
  assert.match(text, /Be discovered for the work itself/);
  assert.match(text, /20%.*galleries commonly take around half/s);
  assert.equal(await visitor.locator('.join-page [data-act=sign-in]').count() > 0, true);
  assert.equal(await visitor.locator('.footer-links a[href="#join"], #menu a[href="#join"]').count() > 0, true);
  step('the artist invitation page explains the offer and leads to sign-up');

  // ——— Share card ———
  const ana = watch(await ctx.newPage());
  await ana.addInitScript(() => sessionStorage.setItem('mockcloud-session', JSON.stringify({ id: 'u-ana@example.com', email: 'ana@example.com' })));
  await ana.goto(BASE + '#profile');
  await ana.waitForFunction(() => /Signed in/.test(document.querySelector('.account-card')?.textContent || ''));
  await ana.click('[data-act=set-role][data-v=artist]');
  await ana.waitForSelector('#upload');
  await ana.setInputFiles('#upload input[type=file]', PHOTO);
  await ana.fill('#upload [name=title]', 'Harbour');
  await ana.fill('#upload [name=price]', '900');
  await ana.click('#upload-submit');
  await ana.waitForSelector('#studio .work-row');
  const id = await ana.evaluate(() => window.__mockdb.load().uploads[0].id);
  await ana.goto(BASE + `#art/${id}`);
  await ana.waitForSelector('[data-act=share-card]');
  const [download] = await Promise.all([ana.waitForEvent('download'), ana.click('[data-act=share-card]')]);
  assert.match(download.suggestedFilename(), /^Harbour\.png$/);
  const file = await download.path();
  const png = readFileSync(file);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1080);
  assert.equal(png.readUInt32BE(20), 1350);
  step('artists get a 1080×1350 share card of their work');

  // ——— Upload several works at once ———
  await ana.goto(BASE + '#profile');
  await ana.waitForSelector('[data-act=batch-open]');
  await ana.click('[data-act=batch-open]');
  await ana.waitForSelector('#batch-files', { state: 'attached' });
  const photo = readFileSync(PHOTO);
  await ana.setInputFiles('#batch-files', ['Hijo.jpg', 'Veronica.jpg', 'IMG_1234.jpg'].map((name) => ({ name, mimeType: 'image/jpeg', buffer: photo })));
  await ana.waitForFunction(() => document.querySelectorAll('.batch-row').length === 3);
  assert.equal(await ana.inputValue('[data-batch="0"][data-k=title]'), 'Hijo', 'titles start from the file names');
  assert.equal(await ana.inputValue('[data-batch="2"][data-k=title]'), '', 'but not camera names');
  await ana.fill('[data-batch=all][data-k=materials]', 'Mixed media on linen');
  await ana.fill('[data-batch=all][data-k=dimensions]', '48 × 36 in');
  await ana.fill('[data-batch=all][data-k=price]', '2400');
  await ana.click('[data-act=batch-apply]');
  await ana.waitForFunction(() => document.querySelector('[data-batch="1"][data-k=price]')?.value === '2400');
  await ana.fill('[data-batch="1"][data-k=title]', 'Verónica');
  await ana.click('[data-act=batch-publish]');
  await ana.waitForSelector('.batch-row.has-error');
  assert.match(await ana.locator('.batch-row.has-error').textContent(), /Give your work a title/);
  assert.equal((await ana.evaluate(() => window.__mockdb.load().uploads.length)), 1, 'nothing published while one is incomplete');
  await ana.fill('[data-batch="2"][data-k=title]', 'Mi valor');
  await ana.click('[data-act=batch-publish]');
  await ana.waitForFunction(() => document.querySelectorAll('.batch-row.is-done').length === 3, null, { timeout: 20000 });
  const ups = await ana.evaluate(() => window.__mockdb.load().uploads.map((u) => ({ title: u.title, medium: u.medium, dimensions: u.dimensions, price: u.price })));
  assert.deepEqual(ups.slice(1).map((u) => u.title).sort(), ['Hijo', 'Mi valor', 'Verónica']);
  assert.ok(ups.slice(1).every((u) => u.medium === 'Mixed media on linen' && u.dimensions === '48 × 36 in' && u.price === 2400), JSON.stringify(ups));
  await ana.click('[data-act=batch-close]');
  await ana.waitForFunction(() => document.querySelectorAll('#studio .work-row').length === 4);
  step('artists upload several works at once, with shared details and per-work checks');

  // ——— Active since ———
  await ana.goto(BASE + '#artist/m_u-ana@example.com');
  await ana.waitForSelector('.artist-header');
  assert.match(await ana.locator('.artist-header').textContent(), /On Abremi since \d{4}/, 'members show when they joined, not a career start');
  await ana.goto(BASE + '#profile');
  await ana.click('[data-act=edit-artist-profile]');
  await ana.waitForSelector('#profile-since');
  await ana.fill('#profile-since', '1994');
  await ana.click('[data-act=save-artist-profile]');
  await ana.waitForSelector('#artist-profile-form', { state: 'hidden' });
  await ana.goto(BASE + '#artist/m_u-ana@example.com');
  await ana.waitForFunction(() => /Active since 1994/.test(document.querySelector('.artist-header')?.textContent || ''));
  step('artists can say when their career began ("Active since 1994"); others show when they joined Abremi');

  // ——— Founding artists ———
  await ana.goto(BASE + '#home');
  await ana.waitForSelector('#view .shell');
  assert.equal(await ana.locator('.founding').count(), 0, 'no section until someone is chosen');
  await ana.goto(BASE + '#artist/m_u-ana@example.com');
  await ana.waitForSelector('.artist-header');
  assert.equal(await ana.locator('[data-act=toggle-founding]').count(), 0, 'only moderators see the button');
  await ana.evaluate(() => { const db = window.__mockdb.load(); db.admins = ['u-ana@example.com']; window.__mockdb.save(db); });
  await ana.reload();
  await ana.waitForSelector('[data-act=toggle-founding]');
  await ana.click('[data-act=toggle-founding]');
  await ana.waitForSelector('.founding-badge');
  assert.match(await ana.locator('.founding-badge').textContent(), /Founding artist/);
  await ana.goto(BASE + '#home');
  await ana.waitForSelector('.founding');
  const section = await ana.locator('.founding').textContent();
  assert.match(section, /Founding artists[\s\S]*not ranked/);
  assert.equal(await ana.locator('.founding .artist-card, .founding [data-act=artist]').count() > 0, true);
  step('moderators choose Founding artists: a labelled home section and a badge, never ranked');

  assert.deepEqual(errors, []);
  console.log('All launch kit e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
