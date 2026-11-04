// End-to-end test of Phase 3 against the stand-in backend: views and visits are recorded once per
// person per day (members and guests apart, never the artist's own), likes and follows show up, and
// the Studio shows real totals with charts, per-work figures and a privacy-safe audience.
// Needs a running server (npm start) and Playwright:  node tests/e2e/studio.e2e.cjs [baseUrl]
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(mock);
  const open = async (user) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    if (user) await p.addInitScript((u) => sessionStorage.setItem('mockcloud-session', JSON.stringify({ id: u, email: u.slice(2) })), user);
    return p;
  };
  const events = (p) => p.evaluate(() => window.__mockdb.load().events || []);

  // ——— An artist publishes ———
  const ana = await open('u-ana@example.com');
  await ana.goto(BASE + '#profile');
  await ana.waitForFunction(() => /Signed in/.test(document.querySelector('.account-card')?.textContent || ''));
  await ana.click('[data-act=set-role][data-v=artist]');
  await ana.waitForSelector('#upload');
  await ana.setInputFiles('#upload input[type=file]', PHOTO);
  await ana.fill('#upload [name=title]', 'Tide Study');
  await ana.fill('#upload [name=price]', '500');
  await ana.click('#upload-submit');
  await ana.waitForSelector('#studio .work-row');
  assert.doesNotMatch(await ana.locator('#studio .work-row').first().textContent(), /Pro/, 'no client-side Pro lock');
  const work = (await ana.evaluate(() => window.__mockdb.load().uploads[0].id));
  await ana.goto(BASE + `#art/${work}`);
  await ana.waitForSelector('.artwork-page');
  await ana.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  step('an artist publishes; analytics are not locked behind a client-side plan');

  // ——— A member and a guest look; the member likes and follows ———
  const ben = await open('u-ben@example.com');
  await ben.goto(BASE + `#art/${work}`);
  await ben.waitForSelector('.artwork-page');
  await ben.reload(); // a second view the same day counts once
  await ben.waitForSelector('.artwork-page');
  await ben.click('.artwork-page [data-act=react][data-v=like]');
  await ben.goto(BASE + '#artist/m_u-ana@example.com');
  await ben.waitForSelector('.artist-page');
  await ben.click('.artist-header [data-act=follow]');
  await ben.goto(BASE + '#explore');
  await ben.selectOption('#explore-sort', 'new');
  await ben.waitForSelector(`.art-frame[data-id="${work}"]`);
  await ben.waitForTimeout(400);
  await ben.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // flush (the page sends when hidden)
  await ben.evaluate(() => Object.defineProperty(document, 'hidden', { value: true, configurable: true }));
  await ben.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const guest = await open(null);
  await guest.goto(BASE + `#art/${work}`);
  await guest.waitForSelector('.artwork-page');
  await guest.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await ana.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await guest.waitForFunction(() => (window.__mockdb.load().events || []).some((e) => !e.member && e.k === 'artwork_view'));
  const ev = await events(guest);
  assert.equal(ev.filter((e) => e.k === 'artwork_view').length, 2, 'Ben once, the guest once; Ana’s own view never');
  assert.equal(ev.filter((e) => e.k === 'profile_visit').length, 1);
  assert.ok(ev.some((e) => e.k === 'impression' && e.member), 'Explore recorded an impression');
  assert.ok(!ev.some((e) => e.viewer === 'u-ana@example.com'), 'never the artist herself');
  step('views, visits and impressions are recorded once per person per day; members and guests apart; never the artist');

  // ——— The Studio ———
  const studio = await open('u-ana@example.com');
  await studio.goto(BASE + '#studio');
  await studio.waitForSelector('.stat-tiles');
  const tileOf = async (label) => (await studio.locator('.stat-tile', { hasText: label }).textContent()).replace(/\s+/g, ' ');
  assert.match(await tileOf('Artwork views'), /Artwork views 2 new 1 members · 1 guests/);
  assert.match(await tileOf('Profile visits'), /Profile visits 1 /);
  assert.match(await tileOf('Likes'), /Likes 1 /);
  assert.match(await tileOf('New followers'), /New followers 1 /);
  assert.equal(await studio.locator('.chart').count(), 3);
  assert.ok(await studio.locator('.chart .bar rect title').count() > 0, 'every bar has a hover title');
  assert.match(await studio.locator('.works-table').textContent(), /Tide Study/);
  assert.match(await studio.locator('.audience').textContent(), /Fan/);
  assert.match(await studio.locator('.audience').textContent(), /Other \(fewer than 3 people each\)/, 'one person’s country is never shown on its own');
  await studio.click('[data-act=studio-days][data-v="7"]');
  await studio.waitForFunction(() => document.querySelectorAll('.chart')[0]?.querySelectorAll('.bar').length === 7);
  assert.match(await studio.locator('.studio').textContent(), /first report arrives/);
  step('the Studio shows recorded totals with change, daily charts with tables, per-work figures and a grouped audience');

  assert.deepEqual(errors, []);
  console.log('All Studio e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
