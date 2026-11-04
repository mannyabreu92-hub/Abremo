// End-to-end test of Phase 2B against the stand-in backend: a moderator creates a competition from
// a template, two artists enter, members vote (one vote each, eligibility enforced, never for your
// own entry), and closing announces results, awards achievements and notifies entrants.
// Needs a running server (npm start) and Playwright:  node tests/e2e/arena.e2e.cjs [baseUrl]
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
  const pages = {};
  const as = async (name) => {
    if (pages[name]) return pages[name];
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    p.on('dialog', (d) => d.accept());
    await p.addInitScript((u) => sessionStorage.setItem('mockcloud-session', JSON.stringify({ id: u, email: u.slice(2) })), `u-${name}@example.com`);
    pages[name] = p;
    return p;
  };
  // Edits the stand-in database from a page (the page must have loaded the app).
  const dbDo = (p, fn, arg) => p.evaluate(fn, arg);

  // ——— Two artists publish a work each ———
  for (const name of ['ana', 'gil']) {
    const p = await as(name);
    await p.goto(BASE + '#profile');
    await p.waitForFunction(() => /Signed in/.test(document.querySelector('.account-card')?.textContent || ''));
    await p.click('[data-act=set-role][data-v=artist]');
    await p.waitForSelector('#upload');
    await p.setInputFiles('#upload input[type=file]', PHOTO);
    await p.fill('#upload [name=title]', name === 'ana' ? 'Harbour Rain' : 'After the Storm');
    await p.fill('#upload [name=price]', '700');
    await p.click('#upload-submit');
    await p.waitForSelector('#studio .work-row');
  }

  // ——— A moderator creates a weekly competition from the template ———
  const mod = await as('mod');
  await mod.goto(BASE + '#home');
  await mod.waitForSelector('.home');
  await dbDo(mod, () => { const d = window.__mockdb.load(); d.admins = ['u-mod@example.com']; window.__mockdb.save(d); });
  await mod.goto(BASE + '#admin');
  await mod.reload(); // moderator status is checked when the account loads
  await mod.waitForSelector('#create-competition');
  await mod.selectOption('#comp-kind', 'challenge');
  await mod.waitForFunction(() => /Creative Challenge/.test(document.querySelector('#comp-title').value));
  await mod.fill('#comp-title', 'The Hour After Rain');
  await mod.click('[data-act=create-competition]');
  await toastSays(mod, /Competition created/);
  let d = await mod.evaluate(() => window.__mockdb.load());
  const comp = d.competitions[0];
  assert.equal(comp.kind, 'challenge');
  assert.ok(comp.rules.includes('One vote per member'), 'the published rules');
  const setTime = (field, ms) => dbDo(mod, ([f, t]) => { const d = window.__mockdb.load(); d.competitions[0][f] = new Date(Date.now() + t).toISOString(); window.__mockdb.save(d); }, [field, ms]);
  await setTime('entries_open_at', -60e3);
  step('a moderator creates a Creative Challenge from a template, with published rules');

  // ——— Artists enter ———
  const ana = await as('ana');
  await ana.goto(BASE + '#battle');
  await ana.click('[data-act=arena-tab][data-v=competitions]');
  await ana.waitForSelector('.competition-card');
  assert.match(await ana.locator('.competition-card').first().textContent(), /Entries open/);
  await ana.click('.competition-card');
  await ana.waitForSelector('.competition-page [data-act=enter-competition]');
  await ana.click('[data-act=enter-competition]');
  await ana.click('#sheet [data-act=enter-with]');
  await toastSays(ana, /You’re in/);
  await ana.waitForSelector('.competition-page [data-act=withdraw-entry]');
  const gil = await as('gil');
  await gil.goto(BASE + `#competition/${comp.id}`);
  await gil.click('.competition-page [data-act=enter-competition]');
  await gil.click('#sheet [data-act=enter-with]');
  await toastSays(gil, /You’re in/);
  d = await mod.evaluate(() => window.__mockdb.load());
  assert.equal(d.entries.length, 2);
  step('artists enter one of their own works from the competition page');

  // ——— Voting ———
  await setTime('voting_opens_at', -30e3);
  const ben = await as('ben');
  await ben.goto(BASE + `#competition/${comp.id}`);
  await ben.waitForFunction(() => /New accounts can vote after 3 days/.test(document.querySelector('.competition-page')?.textContent || ''), );
  assert.equal(await ben.locator('[data-act=vote-entry]').count(), 2, 'entries are shown');
  await ben.click('[data-act=vote-entry] >> nth=0');
  await toastSays(ben, /after 3 days/);
  await dbDo(mod, () => {
    const d = window.__mockdb.load();
    const u = 'u-ben@example.com';
    d.profiles[u].created_at = new Date(Date.now() - 5 * 86400e3).toISOString();
    for (const w of ['w1', 'w2', 'w3', 'w4', 'w5']) d.reactions.push({ user_id: u, artwork_id: w, kind: 'like', role: 'fan', at: Date.now() });
    window.__mockdb.save(d);
  });
  await ben.reload();
  await ben.waitForFunction(() => /Pick one favourite/.test(document.querySelector('.competition-page')?.textContent || ''));
  const entries = d.entries;
  const anaEntry = entries.find((e) => e.user_id === 'u-ana@example.com').id;
  const gilEntry = entries.find((e) => e.user_id === 'u-gil@example.com').id;
  await ben.click(`[data-act=vote-entry][data-v="${anaEntry}"]`);
  await toastSays(ben, /Vote saved/);
  await ben.waitForSelector(`[data-act=vote-entry][data-v="${anaEntry}"][aria-pressed=true]`);
  await ben.click(`[data-act=vote-entry][data-v="${gilEntry}"]`);
  await ben.waitForSelector(`[data-act=vote-entry][data-v="${gilEntry}"][aria-pressed=true]`);
  assert.match(await ben.locator('.competition-page').textContent(), /Vote totals are hidden until voting closes/);
  d = await mod.evaluate(() => window.__mockdb.load());
  assert.deepEqual(d.compVotes.map((v) => v.entry_id), [gilEntry], 'one vote, changed');
  await ana.goto(BASE + '#home');
  await ana.goto(BASE + `#competition/${comp.id}`);
  await ana.reload();
  await ana.waitForSelector('.competition-page .entry-tile');
  assert.equal(await ana.locator(`[data-act=vote-entry][data-v="${anaEntry}"]`).count(), 0, 'no vote button on your own entry');
  step('members vote once (eligibility shown and enforced), can change their vote, never for their own entry; totals hidden');

  // ——— Closing ———
  await setTime('voting_closes_at', -1000);
  await ben.goto(BASE + '#battle');
  await ben.click('[data-act=arena-tab][data-v=history]');
  await ben.waitForSelector('.competition-card');
  assert.match(await ben.locator('.competition-card').first().textContent(), /Results/);
  await ben.click('.competition-card');
  await ben.waitForFunction(() => /1st/.test(document.querySelector('.competition-page')?.textContent || ''));
  assert.match(await ben.locator('.entry-tile.is-winner').textContent(), /After the Storm/);
  assert.match(await ben.locator('.competition-page').textContent(), /1 member voted/);
  step('voting closes on schedule: places and vote totals are published');

  await gil.goto(BASE + '#profile');
  await gil.reload();
  await gil.waitForSelector('#notif-dot:not([hidden])');
  await gil.click('#notif-btn');
  await gil.waitForFunction(() => /placed 1st in “The Hour After Rain”/.test(document.querySelector('#notifications').textContent));
  await gil.click('#notifications .notif');
  await gil.waitForSelector('.competition-page');
  await gil.goto(BASE + '#artist/m_u-gil@example.com');
  await gil.waitForFunction(() => /Competition Winner/.test(document.querySelector('.artist-header .signal-row')?.textContent || ''));
  step('the winner is notified, and Competition Winner shows on their artist page');

  assert.deepEqual(errors, []);
  console.log('All Arena e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
