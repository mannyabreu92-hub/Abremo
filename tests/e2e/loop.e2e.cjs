// End-to-end test of Phase 8 (the discovery-to-ownership loop) against the stand-in backend:
// offers through inquiries, the waitlist and alerts, the optional interests step, Emerging artists,
// and price sorting by real listed prices only.
// Needs a running server (npm start) and Playwright:  node tests/e2e/loop.e2e.cjs [baseUrl]
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const BASE = process.argv[2] || 'http://localhost:5173/';
const mock = readFileSync(path.join(__dirname, 'mock-cloud.js'), 'utf8');
const PHOTO = path.join(__dirname, '..', '..', 'icons', 'screenshot-wide.jpg');
const step = (name) => console.log(`✓ ${name}`);
const toastSays = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#toast').textContent), re.source);

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(mock);
  const open = async (user) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    p.on('dialog', (d) => d.accept());
    await p.addInitScript((u) => sessionStorage.setItem('mockcloud-session', JSON.stringify({ id: u, email: u.slice(2) })), user);
    return p;
  };
  const signedIn = (p) => p.waitForFunction(() => /Signed in/.test(document.querySelector('.account-card')?.textContent || ''));

  // An artist with two works; a collector whose account is old enough to make offers.
  const ana = await open('u-ana@example.com');
  await ana.goto(BASE + '#profile');
  await signedIn(ana);
  await ana.evaluate(() => { const d = window.__mockdb.load(); d.profiles['u-cy@example.com'] = { id: 'u-cy@example.com', name: 'Cy Park', country: 'KR', role: 'fan', created_at: new Date(Date.now() - 30 * 864e5).toISOString(), public_leaderboards: true }; window.__mockdb.save(d); });
  await ana.click('[data-act=set-role][data-v=artist]');
  for (const title of ['Harbour', 'Tideline']) {
    await ana.waitForSelector('#upload');
    await ana.setInputFiles('#upload input[type=file]', PHOTO);
    await ana.fill('#upload [name=title]', title);
    await ana.fill('#upload [name=price]', title === 'Harbour' ? '900' : '1200');
    await ana.click('#upload-submit');
    await ana.waitForFunction((t) => [...document.querySelectorAll('#studio .work-row')].some((r) => r.textContent.includes(t)), title);
  }
  const ids = await ana.evaluate(() => Object.fromEntries(window.__mockdb.load().uploads.map((u) => [u.title, u.id])));
  await ana.evaluate((id) => { const d = window.__mockdb.load(); d.uploads.find((u) => u.id === id).availability = 'sold'; window.__mockdb.save(d); }, ids.Tideline);

  // ——— Offers ———
  const cy = await open('u-cy@example.com');
  await cy.goto(BASE + `#art/${ids.Harbour}`);
  await cy.waitForSelector('[data-act=offer-open]');
  await cy.click('[data-act=offer-open]');
  await cy.fill('#offer-amount', '0');
  await cy.click('[data-act=offer-send]');
  assert.match(await cy.locator('#offer-error').textContent(), /Enter your offer/);
  await cy.fill('#offer-amount', '750');
  await cy.click('[data-act=offer-send]');
  await toastSays(cy, /Offer sent/);
  await cy.waitForSelector('.thread .offer-line');
  assert.match(await cy.locator('.offer-line').textContent(), /USD 750\.00.*nothing is charged/);
  await ana.goto(BASE + '#inbox');
  await ana.reload();
  await ana.waitForSelector('.inquiry-row, .inbox a[href^="#inquiry/"]');
  await ana.click('a[href^="#inquiry/"]');
  await ana.waitForSelector('.thread .offer-line');
  step('a collector makes an offer through an inquiry; both people see it; nothing is charged');

  // ——— Waitlist and alerts ———
  await cy.goto(BASE + `#art/${ids.Tideline}`);
  await cy.waitForSelector('[data-act=watch-toggle]');
  assert.equal(await cy.locator('[data-act=offer-open]').count(), 0, 'no offers on sold works');
  await cy.click('[data-act=watch-toggle]');
  await toastSays(cy, /told if it becomes available/);
  await ana.evaluate(async (id) => {
    const c = await window.__abremiCloud();
    const w = window.__mockdb.load().uploads.find((u) => u.id === id);
    await c.updateArtwork(id, { title: w.title, category: w.category, style: w.style, medium: w.medium, year: w.year, price: w.price, availability: 'available' });
  }, ids.Tideline);
  const alerts = await cy.evaluate(() => window.__mockdb.load().notifications.filter((n) => n.user_id === 'u-cy@example.com' && n.kind === 'artwork_alert').map((n) => n.title));
  assert.deepEqual(alerts, ['“Tideline” is now available']);
  step('the waitlist: notify me on a sold work, and an alert when it becomes available');

  // ——— Interests (optional, after a few swipes) ———
  await cy.goto(BASE + '#discover');
  for (let i = 0; i < 8; i++) {
    await cy.waitForSelector('.deck-actions [data-dir=pass]');
    await cy.click('.deck-actions [data-dir=pass]');
    await cy.waitForTimeout(380);
  }
  await cy.waitForSelector('#interests-form');
  await cy.click('#interests-form [data-act=interest-toggle][data-v=photography]');
  await cy.selectOption('#interest-price', '1000');
  await cy.click('[data-act=interests-save]');
  await toastSays(cy, /Discover will lean toward these/);
  const saved = await cy.evaluate(() => window.__mockdb.load().profiles['u-cy@example.com'].discovery_interests);
  assert.deepEqual([saved.mediums, saved.price_max], [['photography'], 1000]);
  await cy.goto(BASE + '#profile');
  await cy.waitForSelector('[data-act=interests-open]');
  step('after a few swipes, an optional interests step; saved privately and editable from Profile');

  // ——— Emerging and price sorting ———
  await cy.goto(BASE + '#home');
  await cy.waitForSelector('#emerging');
  assert.match(await cy.locator('#emerging').textContent(), /fair daily rotation.*(Harbour|Tideline)/s);
  await cy.goto(BASE + '#explore');
  await cy.selectOption('#explore-sort', 'priceLow');
  await cy.waitForTimeout(400);
  const first = await cy.locator('#view .art-card .art-title').first().textContent();
  assert.match(first, /Harbour/, 'real listed prices first; sample prices aren’t real');
  step('Emerging artists on Home, and price sorting by real listed prices');

  assert.deepEqual(errors, []);
  console.log('All Phase 8 e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
