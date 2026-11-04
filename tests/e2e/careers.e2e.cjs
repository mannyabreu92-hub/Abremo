// End-to-end test of Phase 5 against the stand-in backend (the Coach's model call is a canned draft
// here; the real request is covered by tests/coach.test.js): Opportunities (moderator listing,
// member suggestion and review, fees, saving), the Career Coach (tools, work and listing pickers,
// usage, the draft with its sources), and the Artist Passport (verified exhibitions only).
// Needs a running server (npm start) and Playwright:  node tests/e2e/careers.e2e.cjs [baseUrl]
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
    p.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('No public record') : d.accept()));
    await p.addInitScript((u) => sessionStorage.setItem('mockcloud-session', JSON.stringify({ id: u, email: u.slice(2) })), user);
    return p;
  };
  const signedIn = (p) => p.waitForFunction(() => /Signed in/.test(document.querySelector('.account-card')?.textContent || ''));

  // ——— A moderator publishes a listing ———
  const mod = await open('u-mod@example.com');
  await mod.goto(BASE + '#profile');
  await signedIn(mod);
  await mod.evaluate(() => {
    const d = window.__mockdb.load();
    d.admins = ['u-mod@example.com'];
    d.profiles['u-cy@example.com'] = { id: 'u-cy@example.com', name: 'Cy Park', country: 'KR', role: 'fan', created_at: new Date(Date.now() - 30 * 864e5).toISOString() };
    window.__mockdb.save(d);
  });
  await mod.reload();
  await mod.goto(BASE + '#admin');
  await mod.waitForSelector('[data-act=opportunity-suggest]');
  await mod.click('[data-act=opportunity-suggest]');
  await mod.fill('#op-title', 'Spring Open Call');
  await mod.fill('#op-organizer', 'Galeria Norte');
  await mod.fill('#op-location', 'Lisbon, Portugal');
  await mod.fill('#op-eligibility', 'Painters working in oil');
  await mod.fill('#op-link', 'https://galerianorte.example/call');
  await mod.click('[data-act=opportunity-submit]');
  await toastSays(mod, /Published/);
  step('a moderator publishes a listing directly');

  // ——— A member suggests one; it waits for review ———
  const cy = await open('u-cy@example.com');
  await cy.goto(BASE + '#opportunities');
  await cy.waitForSelector('.opportunity');
  assert.match(await cy.locator('.opportunity').textContent(), /Spring Open Call.*Free to apply/s);
  assert.equal(await cy.locator('.opportunity a[target=_blank]').getAttribute('rel'), 'noopener noreferrer nofollow');
  await cy.click('[data-act=opportunity-suggest]');
  await cy.fill('#op-title', 'Harbour Residency');
  await cy.fill('#op-organizer', 'Casa do Mar');
  await cy.fill('#op-location', 'Porto');
  await cy.fill('#op-fee', '25');
  await cy.fill('#op-currency', 'eur');
  await cy.fill('#op-link', 'http://insecure.example');
  await cy.click('[data-act=opportunity-submit]');
  assert.match(await cy.locator('#op-error').textContent(), /https/);
  await cy.fill('#op-link', 'https://casadomar.example/residency');
  await cy.click('[data-act=opportunity-submit]');
  await toastSays(cy, /moderator will check it/);
  assert.equal(await cy.locator('.opportunity').count(), 1, 'not listed until approved');
  await mod.goto(BASE + '#admin');
  await mod.click('[data-act=admin-reload]');
  await mod.waitForSelector('[data-act=opportunity-review][data-v=approve]');
  await mod.click('[data-act=opportunity-review][data-v=approve]');
  await toastSays(mod, /Done/);
  await cy.goto(BASE + '#home');
  await cy.reload();
  await cy.goto(BASE + '#opportunities');
  await cy.waitForFunction(() => document.querySelectorAll('.opportunity').length === 2);
  assert.match(await cy.locator('.opportunity', { hasText: 'Harbour Residency' }).textContent(), /Application fee: EUR 25/);
  await cy.locator('.opportunity', { hasText: 'Harbour Residency' }).locator('[data-act=opportunity-save]').click();
  await toastSays(cy, /remind you 3 days before/);
  step('members suggest listings; a moderator approves them; fees are shown up front; listings can be saved');

  // ——— The Career Coach ———
  const ana = await open('u-ana@example.com');
  await ana.goto(BASE + '#coach');
  await ana.waitForFunction(() => /Coach is for artists/.test(document.querySelector('#view').textContent));
  await ana.goto(BASE + '#profile');
  await signedIn(ana);
  await ana.click('[data-act=set-role][data-v=artist]');
  await ana.waitForSelector('#upload');
  await ana.setInputFiles('#upload input[type=file]', PHOTO);
  await ana.fill('#upload [name=title]', 'Harbour');
  await ana.fill('#upload [name=price]', '900');
  await ana.click('#upload-submit');
  await ana.waitForSelector('#studio .work-row');
  await ana.click('#studio a[href="#coach"]');
  await ana.waitForSelector('.coach-tools');
  await ana.waitForFunction(() => /20 of 20 requests left/.test(document.querySelector('.coach').textContent));
  assert.match(await ana.locator('.coach header').textContent(), /never invented facts, prices or valuations/);
  await ana.click('[data-act=coach-tool][data-v=description]');
  assert.equal(await ana.locator('#coach-artwork option').count(), 1);
  await ana.click('[data-act=coach-run]');
  await ana.waitForSelector('.coach-result');
  assert.match(await ana.locator('.coach-text').textContent(), /\[Stand-in draft for description\] about “Harbour”/);
  assert.match(await ana.locator('.coach-result .fine').textContent(), /Based on your profile, 1 of your works, “Harbour”/);
  await ana.waitForFunction(() => /19 of 20 requests left/.test(document.querySelector('.coach').textContent));
  await ana.goto(BASE + '#opportunities');
  await ana.waitForSelector('.opportunity [data-act=coach-for-opportunity]');
  await ana.locator('.opportunity', { hasText: 'Spring Open Call' }).locator('[data-act=coach-for-opportunity]').click();
  await ana.waitForSelector('#coach-opportunity');
  await ana.click('[data-act=coach-run]');
  await ana.waitForFunction(() => /for “Spring Open Call”/.test(document.querySelector('.coach-text')?.textContent || ''));
  step('the Coach works for artists only, shows usage, drafts from a chosen work or listing, and says what each draft was based on');

  // ——— The Artist Passport ———
  await ana.goto(BASE + '#profile');
  await ana.click('#studio [data-act=exhibitions-open]');
  await ana.waitForSelector('#exhibition-form');
  await ana.fill('#ex-title', 'Tides');
  await ana.fill('#ex-venue', 'Galeria Norte');
  await ana.fill('#ex-start', '2026-05-01');
  await ana.fill('#ex-link', 'https://galerianorte.example/tides');
  await ana.click('[data-act=exhibition-submit]');
  await toastSays(ana, /Sent for verification/);
  assert.match(await ana.locator('#exhibition-form').textContent(), /Waiting for review/);
  await ana.keyboard.press('Escape');
  await cy.goto(BASE + '#artist/m_u-ana@example.com');
  await cy.waitForSelector('[data-act=artist-tab][data-v=passport]');
  await cy.click('[data-act=artist-tab][data-v=passport]');
  await cy.waitForSelector('.passport');
  assert.match(await cy.locator('.passport').textContent(), /No verified exhibitions yet/, 'not shown before verification');
  assert.match(await cy.locator('.passport').textContent(), /Joined Abremi/);
  await mod.goto(BASE + '#admin');
  await mod.click('[data-act=admin-reload]');
  await mod.waitForSelector('[data-act=exhibition-review][data-v=verify]');
  await mod.click('[data-act=exhibition-review][data-v=verify]');
  await toastSays(mod, /Verified/);
  await cy.reload();
  await cy.waitForSelector('[data-act=artist-tab][data-v=passport]');
  await cy.click('[data-act=artist-tab][data-v=passport]');
  await cy.waitForFunction(() => /Tides/.test(document.querySelector('.passport')?.textContent || ''));
  assert.match(await cy.locator('.passport').textContent(), /Galeria Norte/);
  step('exhibitions appear on the public Passport only after a moderator verifies them; milestones come from records');

  assert.deepEqual(errors, []);
  console.log('All Phase 5 e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
