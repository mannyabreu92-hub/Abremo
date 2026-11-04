// End-to-end test of live updates against the stand-in backend: one tab watches Rankings while
// activity happens elsewhere; the chart updates without a reload, and movement is measured
// against the shared hourly chart (never invented when there is no earlier chart).
// Needs a running server (npm start) and Playwright:  node tests/e2e/live.e2e.cjs [baseUrl]
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(mock);
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  };
  const topArtworks = (p) => p.$$eval('.board:first-of-type .rank-row[data-act=artwork]', (rows) => rows.map((r) => r.dataset.id));

  // ——— A guest watching Rankings ———
  const viewer = await ctx.newPage();
  watch(viewer);
  await viewer.goto(BASE + '#charts');
  await viewer.waitForSelector('.live-badge.is-live');
  assert.match(await viewer.locator('.board:first-of-type').textContent(), /Nothing ranked here yet/, 'nothing is ranked before real activity');
  // Real activity: fans like 40 works, the first one most.
  await viewer.evaluate(() => {
    const db = window.__mockdb.load();
    const ids = Array.from({ length: 40 }, (_, i) => `w${i * 7 + 3}`);
    ids.forEach((id, i) => { for (let n = 0; n < 40 - i; n++) db.reactions.push({ user_id: `u-fan${n}`, artwork_id: id, kind: 'like', role: 'fan' }); });
    window.__mockdb.save(db);
  });
  await viewer.reload();
  await viewer.waitForSelector('.live-badge.is-live');
  assert.doesNotMatch(await viewer.locator('#chart-status').textContent(), /Movement since/, 'no earlier chart yet');
  assert.equal(await viewer.locator('.board:first-of-type .move').count(), 0, 'no movement is invented without an earlier chart');
  await viewer.click('.board:first-of-type [data-act=chart-expand]');
  await viewer.waitForFunction(() => document.querySelectorAll('.board:first-of-type .rank-row').length > 30);
  const before = await topArtworks(viewer);
  const climber = before[29];
  step('Rankings shows “Live”, ranks only real activity, and shows no movement before there is an earlier chart');

  // ——— Activity elsewhere: collectors save the No. 30 artwork ———
  const other = await ctx.newPage();
  watch(other);
  await other.goto(BASE + '#home');
  await other.waitForSelector('.shell');
  await other.evaluate((id) => {
    const db = window.__mockdb.load();
    for (let i = 0; i < 300; i++) {
      const uid = `u-collector${i}`;
      db.profiles[uid] = { id: uid, name: `Collector ${i}`, country: 'FR', role: 'collector', public_leaderboards: true };
      db.reactions.push({ user_id: uid, artwork_id: id, kind: 'super', role: 'collector' });
    }
    window.__mockdb.save(db);
  }, climber);
  const t0 = Date.now();
  await viewer.waitForFunction((id) => document.querySelector('.board:first-of-type .rank-row[data-act=artwork]')?.dataset.id === id, climber, { timeout: 10000 });
  assert.ok(Date.now() - t0 < 6000, 'the update arrives within seconds, not at the next 90-second poll');
  step(`the watching tab updates without a reload (No. 30 → No. 1 in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // ——— The shared hourly chart: an hour ago, only the fans' likes existed ———
  await other.evaluate(() => {
    const db = window.__mockdb.load();
    const hour = new Date(); hour.setMinutes(0, 0, 0); hour.setHours(hour.getHours() - 1);
    db.history = (db.history || []).filter((x) => Date.parse(x.hour) >= hour.getTime() + 3600e3);
    db.history.push({ hour: hour.toISOString(), taken_at: hour.toISOString(), snapshot: {
      reactions: Object.values(db.reactions.filter((r) => r.role === 'fan').reduce((m, r) => { (m[r.artwork_id] ||= { a: r.artwork_id, k: 'like', r: 'fan', n: 0 }).n++; return m; }, {})),
      reviews: [], follows: [], ratings: [], members: 40 } });
    window.__mockdb.save(db);
  });
  await viewer.reload();
  await viewer.waitForSelector('.chart-since');
  assert.match(await viewer.locator('.chart-since').textContent(), /Movement since/);
  const firstRow = viewer.locator('.board:first-of-type .rank-row').first();
  assert.equal(await firstRow.getAttribute('data-id'), climber);
  assert.equal(await firstRow.locator('.move').getAttribute('aria-label'), 'Up 29');
  step('movement is measured against the shared earlier chart (↑ 29)');

  assert.deepEqual(errors, []);
  console.log('All live update e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
