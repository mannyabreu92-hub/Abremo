// End-to-end test of Critic & Collector applications against the stand-in backend:
// apply → moderator reviews → applicant's role and vote weight change → moderator can revoke.
// The applicant and the moderator are signed in at the same time, in two tabs.
// Needs a running server (npm start) and Playwright:  node tests/e2e/applications.e2e.cjs [baseUrl]
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const BASE = process.argv[2] || 'http://localhost:5173/';
const mock = readFileSync(path.join(__dirname, 'mock-cloud.js'), 'utf8');
const step = (name) => console.log(`✓ ${name}`);
const STATEMENT = 'I have written about contemporary painting for eight years, for two art quarterlies and a regional newspaper.';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(mock);
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    p.on('dialog', (d) => d.accept());
  };
  const db = (p) => p.evaluate(() => window.__mockdb.load());
  const refresh = (p) => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  // ——— The applicant ———
  const ana = await ctx.newPage();
  watch(ana);
  await ana.goto(BASE + '#profile');
  await ana.waitForSelector('.account-card');
  await ana.click('.account-card [data-act=sign-in]');
  await ana.fill('#auth-email', 'ana@example.com');
  await ana.click('[data-act=send-link]');
  await ana.fill('#auth-code', '123456');
  await ana.click('[data-act=verify-code]');
  await ana.waitForFunction(() => document.querySelector('#nav-profile .avatar'));
  await ana.goto(BASE + '#profile');
  await ana.waitForSelector('.role-card[data-v=critic] .role-lock');
  assert.match(await ana.locator('.role-card[data-v=critic] .role-lock').textContent(), /Apply for verification/);
  await ana.click('.role-card[data-v=critic]');
  await ana.waitForSelector('#apply-form');
  await ana.click('[data-act=apply-role]');
  assert.match(await ana.locator('#apply-error').textContent(), /40 characters/);
  await ana.fill('#apply-statement', STATEMENT);
  await ana.fill('#apply-links', 'http://insecure.example');
  await ana.click('[data-act=apply-role]');
  assert.match(await ana.locator('#apply-error').textContent(), /https/);
  await ana.fill('#apply-links', 'https://example.org/ana-writing');
  await ana.click('[data-act=apply-role]');
  assert.match(await ana.locator('#apply-error').textContent(), /accurate/);
  await ana.check('#apply-honest');
  await ana.click('[data-act=apply-role]');
  await ana.waitForFunction(() => /Application sent/.test(document.querySelector('#toast').textContent));
  await ana.waitForSelector('.role-card[data-v=critic] .role-lock.is-pending');
  assert.equal((await db(ana)).applications[0].status, 'pending');
  assert.equal((await db(ana)).profiles['u-ana@example.com'].role, 'fan', 'applying grants nothing');
  await ana.click('.role-card[data-v=critic]');
  await ana.waitForSelector('#sheet.open [data-act=withdraw-application]');
  await ana.keyboard.press('Escape');
  step('apply: validation (length, https links, honesty), then “Application pending”');

  // Non-moderators can't reach the review page.
  await ana.goto(BASE + '#admin');
  await ana.waitForFunction(() => /Moderators only/.test(document.querySelector('#view').textContent));
  assert.notEqual(await ana.locator('#menu-admin').getAttribute('hidden'), null);
  step('the review page is for moderators only');

  // ——— The moderator, signed in in another tab ———
  await ana.evaluate(() => { const d = window.__mockdb.load(); d.admins = ['u-boss@example.com']; window.__mockdb.save(d); });
  const boss = await ctx.newPage();
  watch(boss);
  await boss.addInitScript(() => sessionStorage.setItem('mockcloud-session', JSON.stringify({ id: 'u-boss@example.com', email: 'boss@example.com' })));
  await boss.goto(BASE + '#profile');
  await boss.waitForSelector('.account-card [href="#admin"]');
  assert.equal(await boss.locator('#menu-admin').getAttribute('hidden'), null);
  await boss.goto(BASE + '#admin');
  await boss.waitForSelector('.app-card');
  const card = boss.locator('.app-card').first();
  assert.match(await card.textContent(), new RegExp(STATEMENT.slice(0, 40)));
  assert.equal(await card.locator('.app-links a').getAttribute('rel'), 'noopener noreferrer nofollow');
  await boss.fill('.app-card textarea', 'Welcome to the critics.');
  await boss.click('.app-card [data-act=admin-decide][data-v=approve]');
  await boss.waitForFunction(() => /All caught up/.test(document.querySelector('.admin')?.textContent || ''));
  assert.equal((await db(boss)).profiles['u-ana@example.com'].role, 'critic');
  step('the moderator sees the application (with safe links) and approves it');

  // ——— Back to the applicant: the decision arrives and her votes weigh ×5 ———
  await ana.goto(BASE + '#profile');
  await refresh(ana);
  await ana.waitForFunction(() => /application was approved/.test(document.querySelector('#toast').textContent));
  await ana.waitForFunction(() => /Critic/.test(document.querySelector('#nav-profile').textContent));
  await ana.goto(BASE + '#discover');
  await ana.waitForSelector('.swipe-card.is-top');
  await ana.click('.deck-like');
  await ana.waitForSelector('.influence-chip');
  assert.match(await ana.locator('.influence-chip').textContent(), /\+5\s*Influence added/);
  step('the applicant is told, becomes a Critic, and a like now adds +5');

  // ——— Revoking ———
  await boss.goto(BASE + '#admin');
  await boss.click('[data-act=admin-reload]');
  await boss.waitForSelector('[data-act=admin-revoke]');
  await boss.click('[data-act=admin-revoke]');
  await boss.waitForFunction(() => /Role removed/.test(document.querySelector('#toast').textContent));
  await ana.reload();
  await ana.waitForFunction(() => /removed by a moderator/.test(document.querySelector('#toast').textContent));
  await ana.waitForFunction(() => /Fan/.test(document.querySelector('#nav-profile').textContent));
  step('a moderator can remove the role');


  // ——— Withdrawing, then a decline with a note ———
  const applyCollector = async () => {
    await ana.goto(BASE + '#profile');
    await ana.click('.role-card[data-v=collector]');
    await ana.fill('#apply-statement', 'I collect works on paper from emerging Caribbean artists and lend them to local shows.');
    await ana.check('#apply-honest');
    await ana.click('[data-act=apply-role]');
    await ana.waitForSelector('.role-card[data-v=collector] .role-lock.is-pending');
  };
  await applyCollector();
  await ana.click('.role-card[data-v=collector]');
  await ana.click('#sheet.open [data-act=withdraw-application]');
  await ana.waitForFunction(() => !document.querySelector('.role-card[data-v=collector] .role-lock.is-pending'));
  assert.equal((await db(ana)).applications.at(-1).status, 'withdrawn');
  await applyCollector();
  await boss.click('[data-act=admin-reload]');
  await boss.waitForSelector('.app-card');
  await boss.fill('.app-card textarea', 'Please add links to the shows.');
  await boss.click('.app-card [data-act=admin-decide][data-v=decline]');
  await boss.waitForFunction(() => /All caught up/.test(document.querySelector('.admin')?.textContent || ''));
  await refresh(ana);
  await ana.waitForFunction(() => /declined: Please add links/.test(document.querySelector('#toast').textContent));
  await ana.waitForSelector('.role-card[data-v=collector] .role-lock.is-declined');
  assert.match(await ana.locator('#nav-profile').textContent(), /Fan/);
  // Three applications in 30 days is the limit.
  await ana.click('.role-card[data-v=collector]');
  assert.match(await ana.locator('.apply-declined').textContent(), /Please add links to the shows/);
  await ana.fill('#apply-statement', 'Here are the exhibitions I have lent to over the last three years, with links.');
  await ana.check('#apply-honest');
  await ana.click('[data-act=apply-role]');
  await ana.waitForFunction(() => /three applications/.test(document.querySelector('#apply-error')?.textContent || ''));
  step('withdraw, decline with a note, and the 3-per-30-days limit');

  assert.deepEqual(errors, []);
  console.log('All application e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
