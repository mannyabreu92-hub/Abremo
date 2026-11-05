// End-to-end test of the member leaderboards: demo mode explains itself; community mode ranks
// real members (stand-in backend), highlights you, filters by country and respects opting out.
// Needs a running server (npm start) and Playwright:  node tests/e2e/members.e2e.cjs [baseUrl]
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const BASE = process.argv[2] || 'http://localhost:5173/';
const mock = readFileSync(path.join(__dirname, 'mock-cloud.js'), 'utf8');
const step = (name) => console.log(`✓ ${name}`);

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // Demo mode: no invented members.
  const demo = await (await browser.newContext()).newPage();
  demo.on('pageerror', (e) => errors.push(e.message));
  await demo.goto(BASE + '#charts');
  await demo.click('.seg-gold [data-v=members]');
  await demo.waitForSelector('.empty-state');
  assert.match(await demo.locator('.empty-state').textContent(), /go live with accounts/);
  assert.equal(await demo.locator('.rank-list li').count(), 0);
  step('demo mode: Members tab explains that boards need real accounts');

  // Community mode.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(mock);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(BASE + '#profile');
  await page.waitForSelector('.account-card');
  await page.click('.account-card [data-act=sign-in]');
  await page.fill('#auth-email', 'scout@example.com');
  await page.click('[data-act=send-link]');
  await page.fill('#auth-code', '123456');
  await page.click('[data-act=verify-code]');
  await page.waitForFunction(() => document.querySelector('#nav-profile .avatar'));
  const myName = await page.evaluate(() => JSON.parse(localStorage.getItem('abremi:v1')).user.name);
  assert.match(myName, /^Member [0-9A-F]{4}$/);
  await page.goto(BASE + '#home');
  await page.waitForSelector('.hero-actions');
  assert.equal(await page.locator('.landing-proof').count(), 0, 'small member counts stay hidden');
  assert.doesNotMatch(await page.locator('#view').textContent(), /members shaping/);
  step(`new members get a neutral public name (${myName}), not their email`);

  // The scout likes three works first (through the real UI).
  await page.goto(BASE + '#discover');
  const found = [];
  for (let i = 0; i < 3; i++) {
    await page.waitForSelector('.swipe-card.is-top:not([data-leaving])');
    found.push(await page.locator('.swipe-card.is-top').getAttribute('data-id'));
    await page.click('.deck-like');
    await page.waitForTimeout(450);
  }
  await page.waitForSelector('.celebrate', { state: 'detached', timeout: 8000 }).catch(() => {});

  // Other members arrive later: a verified collector, a verified critic with a review, two fans.
  await page.evaluate((works) => {
    const db = window.__mockdb.load();
    const add = (id, name, country, role) => { db.profiles[id] = { id, name, country, role, public_leaderboards: true }; };
    add('u-col', 'Isabel Marte', 'DO', 'collector');
    add('u-cri', 'Karim Laurent', 'FR', 'critic');
    add('u-f1', 'Lena Park', 'US', 'fan');
    add('u-f2', 'Omar Diaz', 'US', 'fan');
    let t = Date.now() + 1000;
    for (const w of works) {
      db.reactions.push({ user_id: 'u-col', artwork_id: w, kind: 'super', role: 'collector', at: t++ });
      db.reactions.push({ user_id: 'u-cri', artwork_id: w, kind: 'like', role: 'critic', at: t++ });
      db.reactions.push({ user_id: 'u-f1', artwork_id: w, kind: 'like', role: 'fan', at: t++ });
      db.reactions.push({ user_id: 'u-f2', artwork_id: w, kind: 'like', role: 'fan', at: t++ });
    }
    db.reviews.push({ user_id: 'u-cri', artwork_id: works[0], rating: 5, body: '', role: 'critic', created_at: new Date().toISOString() });
    window.__mockdb.save(db);
  }, found);

  await page.goto(BASE + '#charts');
  await page.click('.seg-gold [data-v=members]');
  await page.waitForSelector('.standing');
  const boards = await page.locator('.board').allTextContents();
  assert.match(boards[0], /Top Discoverers/);
  const firstDiscoverer = page.locator('.board').nth(0).locator('.rank-list li').first();
  assert.ok((await firstDiscoverer.getAttribute('class')).includes('is-me'), 'the earliest discoverer is you, highlighted');
  assert.match(await firstDiscoverer.textContent(), new RegExp(myName));
  assert.match(boards[1], /Top Collectors[\s\S]*Isabel Marte[\s\S]*54/);
  assert.match(boards[2], /Top Critics[\s\S]*Karim Laurent[\s\S]*1 review/);
  assert.match(await page.locator('.standing').textContent(), /No\. 1/);
  assert.ok(!(await page.locator('.charts').textContent()).includes('@'), 'no emails anywhere');
  step('Top Discoverers puts the early scout first; collectors and critics ranked; your standing shown');

  await page.click('[data-act=members-scope][data-v=US]');
  await page.waitForSelector('[data-act=members-scope][data-v=US].is-on');
  await page.waitForTimeout(200);
  assert.ok(!(await page.locator('.charts').textContent()).includes('Isabel Marte'), 'country filter');
  step('country filter');

  // Seasons and medium leagues
  await page.click('[data-act=members-scope][data-v=""]');
  await page.waitForSelector('[data-act=members-scope][data-v=""].is-on');
  const seasons = page.locator('[data-act=members-season]');
  assert.equal(await seasons.count(), 3);
  await seasons.nth(2).click(); // last month: nothing happened then
  await page.waitForSelector('[data-act=members-season].is-on >> nth=0');
  await page.waitForFunction(() => /Nobody here yet/.test(document.querySelector('.board')?.textContent || ''));
  await seasons.nth(1).click(); // this month
  await page.waitForFunction(() => document.querySelector('.board .rank-list li.is-me'));
  assert.match(await page.locator('.standing .eyebrow').textContent(), /worldwide · [A-Z][a-z]+ \d{4}/);
  await page.selectOption('#members-medium', 'sculpture');
  await page.waitForFunction(() => /Sculpture/.test(document.querySelector('.standing .eyebrow')?.textContent || ''));
  assert.equal(await page.locator('#members-medium').inputValue(), 'sculpture');
  await page.selectOption('#members-medium', '');
  await seasons.nth(0).click();
  await page.waitForFunction(() => document.querySelector('.board .rank-list li.is-me'));
  step('seasons (all time, this month, last month) and medium leagues');

  // Art Battle streak on the profile
  await page.goto(BASE + '#battle');
  await page.waitForSelector('.vote-btn');
  await page.locator('.vote-btn').first().click();
  await page.waitForTimeout(400);
  await page.goto(BASE + '#profile');
  await page.waitForSelector('.streak-panel');
  assert.match(await page.locator('.streak-panel').textContent(), /1 day[\s\S]*voted today[\s\S]*Next milestone: 7 days/);
  step('a daily Art Battle streak on your profile');

  await page.goto(BASE + '#profile');
  await page.uncheck('#public-leaderboards');
  await page.waitForTimeout(200);
  assert.equal((await page.evaluate(() => window.__mockdb.load())).profiles['u-scout@example.com'].public_leaderboards, false);
  await page.goto(BASE + '#charts');
  await page.click('.seg-gold [data-v=members]');
  await page.waitForSelector('.standing');
  assert.match(await page.locator('.standing').textContent(), /only you can see your position/);
  await page.goto(BASE + '#profile');
  await page.click('[data-act=sign-out]');
  await page.waitForFunction(() => document.querySelector('#nav-profile')?.textContent.includes('Sign in'));
  await page.goto(BASE + '#charts');
  await page.click('.seg-gold [data-v=members]');
  await page.waitForSelector('.board');
  await page.waitForTimeout(200);
  assert.ok(!(await page.locator('.charts').textContent()).includes(myName), 'opted-out members are hidden from others');
  step('opting out hides you from everyone else, while you still see your own position');

  assert.deepEqual(errors, []);
  console.log('All member leaderboard e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
