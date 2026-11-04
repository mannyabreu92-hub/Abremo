// End-to-end test of community mode against the in-browser stand-in backend.
// Needs a running server (npm start) and Playwright:  node tests/e2e/community.e2e.cjs [baseUrl]
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const BASE = process.argv[2] || 'http://localhost:5173/';
const mock = readFileSync(path.join(__dirname, 'mock-cloud.js'), 'utf8');

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(mock);
  const db = () => page.evaluate(() => window.__mockdb.load());
  const toastText = async () => (await page.locator('#toast').textContent()) || '';
  const influenceOf = async (id) => {
    await page.evaluate((i) => { const b = document.createElement('button'); b.dataset.act = 'artwork'; b.dataset.id = i; document.body.append(b); b.click(); b.remove(); }, id);
    await page.waitForSelector('#sheet.open .influence-head span');
    const v = await page.locator('.influence-head span').textContent();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    return v;
  };
  const step = (name) => console.log(`✓ ${name}`);

  await page.goto(BASE);
  await page.waitForSelector('.hero');
  await page.waitForFunction(() => document.querySelector('#nav-profile')?.textContent.includes('Sign in'));
  step('guest sees Sign in');

  const firstId = await page.locator('.art-grid .art-card .quick-btn[data-v=like]').first().getAttribute('data-id');
  const baseInfluence = await influenceOf(firstId);
  await page.locator(`.art-grid .quick-btn[data-v=like][data-id="${firstId}"]`).first().click();
  await page.waitForTimeout(150);
  assert.match(await toastText(), /Sign in so your admirations count/);
  assert.equal((await db()).reactions.length, 0);
  assert.equal(await influenceOf(firstId), baseInfluence);
  step('guest likes are kept on the device and do not move rankings');

  await page.click('#nav-profile');
  await page.fill('#auth-email', 'not-an-email');
  await page.click('[data-act=send-link]');
  await page.waitForSelector('.form-error');
  await page.fill('#auth-email', 'ana@example.com');
  await page.click('[data-act=send-link]');
  await page.waitForSelector('#auth-code');
  await page.fill('#auth-code', '000000');
  await page.click('[data-act=verify-code]');
  await page.waitForSelector('.form-error');
  assert.match(await page.locator('.form-error').textContent(), /invalid or has expired/);
  await page.fill('#auth-code', '123456');
  await page.click('[data-act=verify-code]');
  await page.waitForFunction(() => /added to your account/.test(document.querySelector('#toast').textContent));
  let d = await db();
  assert.deepEqual(d.reactions.map((r) => [r.artwork_id, r.kind, r.role]), [[firstId, 'like', 'fan']]);
  assert.ok(await page.locator('#nav-profile .avatar').count());
  step('sign in with email code; guest like imported to the account');

  assert.equal(Number(await influenceOf(firstId)), Number(baseInfluence) + 1);
  step('the like now counts in the community total');

  await page.goto(BASE + '#profile');
  await page.waitForSelector('.account-card');
  assert.match(await page.locator('.account-card').textContent(), /ana@example.com/);
  await page.click('[data-act=set-role][data-v=critic]');
  await page.waitForSelector('#sheet.open #apply-form');
  assert.equal((await db()).profiles['u-ana@example.com'].role, 'fan', 'Critic is not self-service');
  await page.keyboard.press('Escape');
  await page.click('[data-act=set-role][data-v=artist]');
  await page.waitForTimeout(200);
  assert.equal((await db()).profiles['u-ana@example.com'].role, 'artist');
  step('Fan/Artist are self-service; Critic opens an application');

  await page.goto(BASE + '#discover');
  await page.waitForSelector('.swipe-card.is-top');
  const swipedId = await page.locator('.swipe-card.is-top').getAttribute('data-id');
  await page.click('.deck-like');
  await page.waitForTimeout(600);
  d = await db();
  assert.deepEqual(d.reactions.find((r) => r.artwork_id === swipedId)?.role, 'artist');
  step('a swipe is saved with the server-side role');

  await page.goto(BASE + '#battle');
  await page.waitForSelector('.vote-btn');
  await page.locator('.vote-btn').first().click();
  await page.waitForTimeout(300);
  d = await db();
  assert.equal(d.votes.length, 1);
  assert.equal(d.votes[0].role, 'artist');
  step('battle vote recorded by the server');

  await page.evaluate(() => localStorage.removeItem('abremi:v1'));
  await page.goto(BASE + '#collections');
  await page.reload();
  await page.waitForFunction(() => /2 works/.test(document.querySelector('.collection-grid')?.textContent || ''));
  step('after clearing the device, likes are restored from the account');

  await page.goto(BASE + '#profile');
  await page.waitForSelector('[data-act=sign-out]');
  await page.click('[data-act=sign-out]');
  await page.waitForFunction(() => document.querySelector('#nav-profile')?.textContent.includes('Sign in'));
  await page.goto(BASE + '#collections');
  await page.waitForSelector('.collection-card.is-empty');
  step('sign out clears the account from the device');

  await page.click('#nav-profile');
  await page.fill('#auth-email', 'ben@example.com');
  await page.click('[data-act=send-link]');
  await page.fill('#auth-code', '123456');
  await page.click('[data-act=verify-code]');
  await page.waitForFunction(() => /Welcome/.test(document.querySelector('#toast').textContent));
  assert.equal(Number(await influenceOf(firstId)), Number(baseInfluence) + 1);
  await page.goto(BASE + '#artists');
  await page.waitForSelector('.artist-card .follow-btn');
  await page.locator('.artist-card .follow-btn').first().click();
  await page.waitForTimeout(250);
  d = await db();
  assert.equal(d.follows.length, 1);
  assert.equal(d.follows[0].user_id, 'u-ben@example.com');
  assert.equal(Object.keys(d.profiles).length, 2);
  step('a second member sees the first member\'s like, and can follow');

  assert.deepEqual(errors, []);
  console.log('All community e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
