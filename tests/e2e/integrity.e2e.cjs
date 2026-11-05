// End-to-end test of Phase 2A against the stand-in backend: own likes don't count, the server's
// scores drive Rankings (All Time, Trending This Week, Collectors' Picks), the published
// "How rankings work", moderators reviewing a burst from new accounts, and server achievements.
// Needs a running server (npm start) and Playwright:  node tests/e2e/integrity.e2e.cjs [baseUrl]
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
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    p.on('dialog', (d) => d.accept());
  };
  const signedInAs = (p, id) => p.addInitScript((u) => sessionStorage.setItem('mockcloud-session', JSON.stringify({ id: u, email: u.slice(2) })), id);

  // ——— An artist publishes, then likes their own work ———
  const ana = await ctx.newPage();
  watch(ana);
  await signedInAs(ana, 'u-ana@example.com');
  await ana.goto(BASE + '#profile');
  await ana.waitForSelector('.account-card');
  await ana.click('[data-act=set-role][data-v=artist]');
  await ana.waitForSelector('#upload');
  await ana.setInputFiles('#upload input[type=file]', PHOTO);
  await ana.fill('#upload [name=title]', 'Harbour');
  await ana.fill('#upload [name=price]', '800');
  await ana.click('#upload-submit');
  // The toast is brief and can be replaced by another message on a busy machine; the work appearing is what matters.
  await ana.waitForFunction(() => window.__mockdb.load().uploads.length > 0 && document.querySelector('#studio .work-row'), null, { timeout: 15000 });
  const db = () => ana.evaluate(() => window.__mockdb.load());
  const work = (await db()).uploads[0].id;
  await ana.goto(BASE + `#art/${work}`);
  await ana.waitForSelector('.artwork-page [data-act=react][data-v=like]');
  await ana.click('.artwork-page [data-act=react][data-v=like]');
  await toastSays(ana, /own admirations don’t count/);
  await ana.waitForTimeout(300);
  const snap = await ana.evaluate(async () => (await window.__abremiCloud()).snapshot());
  assert.equal((snap.scores.find((x) => x.a === work) || { p: 0 }).p, 0, 'a self-like adds nothing');
  step('an artist’s own like is saved for them but adds nothing to the rankings');

  // ——— Real activity from others: All Time, Trending This Week and Collectors' Picks ———
  await ana.evaluate((w) => {
    const d = window.__mockdb.load();
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      const id = `u-old${i}`;
      d.profiles[id] = { id, name: `Old ${i}`, country: 'FR', role: i < 2 ? 'collector' : 'fan', created_at: new Date(now - 90 * 86400e3).toISOString() };
      d.reactions.push({ user_id: id, artwork_id: w, kind: 'like', role: d.profiles[id].role, at: now - 60_000 });
      d.reactions.push({ user_id: id, artwork_id: 'w33', kind: 'like', role: 'fan', at: now - 30 * 86400e3 }); // a month ago
    }
    window.__mockdb.save(d);
  }, work);
  await ana.goto(BASE + '#charts');
  await ana.reload();
  await ana.waitForSelector('[data-board=trending] .rank-row');
  assert.equal(await ana.locator('[data-board=trending] .rank-row').first().getAttribute('data-id'), work, 'recent likes lead Trending');
  assert.match(await ana.locator('[data-board=artworks]').textContent(), /Harbour/);
  assert.equal(await ana.locator('[data-board=collected] .rank-row').first().getAttribute('data-id'), work, 'collectors liked it');
  await ana.click('[data-act=how-ranked]');
  await ana.waitForSelector('#sheet.open .how-ranked');
  const how = await ana.locator('#sheet .how-ranked').textContent();
  for (const s of ['Artwork popularity', 'Artist reputation', 'Critic credibility', 'Collector interest', 'Battle performance', 'own work', 'no payment']) assert.ok(how.includes(s), s);
  await ana.keyboard.press('Escape');
  step('Rankings use the server’s scores: All Time, Trending This Week (decayed), Collectors’ Picks, and the published rules');

  // ——— Achievements, earned on the server ———
  await ana.goto(BASE + '#profile');
  await ana.waitForFunction(() => document.querySelectorAll('.achievement-card').length > 0);
  await ana.waitForFunction(() => [...document.querySelectorAll('.achievement-card.is-earned')].some((c) => /First Work/.test(c.textContent)));
  await ana.goto(BASE + '#artist/m_u-ana@example.com');
  await ana.waitForFunction(() => /First Work/.test(document.querySelector('.artist-header .signal-row')?.textContent || ''));
  step('achievements come from the server with their criteria; artist ones show on the artist page');

  // ——— A burst from brand-new accounts, reviewed by a moderator ———
  await ana.evaluate(() => {
    const d = window.__mockdb.load();
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      const id = `u-new${i}`;
      d.profiles[id] = { id, name: `New ${i}`, country: 'US', role: 'fan', created_at: new Date(now - 3600e3).toISOString() };
      d.reactions.push({ user_id: id, artwork_id: 'w77', kind: 'like', role: 'fan', at: now - 10_000 + i });
    }
    d.admins = ['u-mod@example.com'];
    window.__mockdb.save(d);
  });
  const mod = await ctx.newPage();
  watch(mod);
  await signedInAs(mod, 'u-mod@example.com');
  await mod.goto(BASE + '#charts');
  await mod.waitForSelector('[data-board=artworks] .rank-row[data-id=w77]'); // the burst counts until a moderator reviews it
  await mod.goto(BASE + '#admin');
  await mod.waitForSelector('.flag-card');
  assert.match(await mod.locator('.flag-card').textContent(), /10 likes or saves in an hour, 10 of them from accounts under 3 days old/);
  await mod.fill('.flag-card input', 'Coordinated new accounts');
  await mod.click('.flag-card [data-act=flag-resolve][data-v=exclude]');
  await toastSays(mod, /10 likes excluded/);
  await mod.waitForFunction(() => /excluded a burst of likes/.test(document.querySelector('.audit-list')?.textContent || ''));
  assert.match(await mod.locator('.audit-list').textContent(), /Coordinated new accounts/);
  await mod.goto(BASE + '#charts');
  await mod.waitForFunction(() => document.querySelector('[data-board=artworks] .rank-row') && !document.querySelector('[data-board=artworks] .rank-row[data-id=w77]'));
  assert.equal((await db()).reactions.filter((r) => r.artwork_id === 'w77').length, 10, 'nothing is deleted');
  step('a moderator reviews a burst from new accounts; excluding it is recorded and never deletes anything');

  assert.deepEqual(errors, []);
  console.log('All Phase 2A e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
