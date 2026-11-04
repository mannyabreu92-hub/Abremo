// End-to-end test of Phase 6 against the stand-in backend: Plans (shown, never sold while payments are
// off; granted by moderators; limits follow the plan; badges never touch rankings), gallery accounts,
// invite-only sign-up, feedback and the app error log.
// Needs a running server (npm start) and Playwright:  node tests/e2e/membership.e2e.cjs [baseUrl]
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const BASE = process.argv[2] || 'http://localhost:5173/';
const mock = readFileSync(path.join(__dirname, 'mock-cloud.js'), 'utf8');
const PHOTO = path.join(__dirname, '..', '..', 'icons', 'screenshot-wide.jpg');
const step = (name) => console.log(`✓ ${name}`);
const toastSays = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#toast').textContent), re.source);
const textOf = (page, sel) => page.locator(sel).first().textContent();

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p) => {
    p.on('pageerror', (e) => { if (!/Boom from the e2e test/.test(e.message)) errors.push(e.message); });
    p.on('console', (m) => m.type() === 'error' && !/Boom from the e2e test/.test(m.text()) && errors.push(m.text()));
    p.on('dialog', (d) => d.accept());
    return p;
  };

  // ——— Demo mode: plans are described, never sold ———
  const demo = watch(await browser.newPage({ viewport: { width: 390, height: 844 } }));
  await demo.goto(BASE + '#plans');
  await demo.waitForSelector('.plans-page');
  assert.equal(await demo.locator('.plan').count(), 4);
  assert.match(await textOf(demo, '.plans-page'), /on-device preview/);
  assert.match(await textOf(demo, '.plans-page'), /never change how work is ranked/);
  await demo.goto(BASE + '#profile');
  await demo.waitForSelector('.profile, .shell');
  assert.doesNotMatch(await demo.locator('#view').textContent(), /\$7\.99|Choose Pro/, 'no demo prices or fake upgrades');
  assert.equal(await demo.evaluate(() => document.documentElement.scrollWidth), 390, 'no sideways scroll on a phone');
  step('demo mode: plans are described, with no prices or fake upgrades');

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(mock);
  const open = async (user) => {
    const p = watch(await ctx.newPage());
    if (user) await p.addInitScript((u) => sessionStorage.setItem('mockcloud-session', JSON.stringify({ id: u, email: u.slice(2) })), user);
    return p;
  };
  const signedIn = (p) => p.waitForFunction(() => /Signed in/.test(document.querySelector('.account-card')?.textContent || ''));

  // ——— Set up: a moderator, an artist and a gallery owner with older accounts ———
  const mod = await open('u-mod@example.com');
  await mod.goto(BASE + '#profile');
  await signedIn(mod);
  await mod.evaluate(() => {
    const d = window.__mockdb.load();
    d.admins = ['u-mod@example.com'];
    const old = new Date(Date.now() - 30 * 864e5).toISOString();
    d.profiles['u-ana@example.com'] = { id: 'u-ana@example.com', name: 'Ana Sousa', country: 'PT', role: 'fan', created_at: old, public_leaderboards: true };
    d.profiles['u-cy@example.com'] = { id: 'u-cy@example.com', name: 'Cy Park', country: 'KR', role: 'fan', created_at: old, public_leaderboards: true };
    window.__mockdb.save(d);
  });
  await mod.reload();

  // ——— Plans in community mode: nothing on sale; Free by default ———
  const ana = await open('u-ana@example.com');
  await ana.goto(BASE + '#profile');
  await signedIn(ana);
  await ana.click('[data-act=set-role][data-v=artist]');
  await ana.waitForSelector('#upload');
  await ana.setInputFiles('#upload input[type=file]', PHOTO);
  await ana.fill('#upload [name=title]', 'Harbour');
  await ana.fill('#upload [name=price]', '900');
  await ana.click('#upload-submit');
  await ana.waitForSelector('#studio .work-row');
  await ana.goto(BASE + '#plans');
  await ana.waitForSelector('.plans-page');
  const plans = await textOf(ana, '.plans-page');
  assert.match(plans, /Paid plans aren’t on sale yet/);
  assert.match(plans, /Price to be announced/);
  assert.match(await textOf(ana, '.plan.is-on'), /Artist Free/);
  assert.equal(await ana.locator('[data-act=plan-checkout]').count(), 0, 'no checkout while payments are off');
  await ana.goto(BASE + '#studio');
  await ana.waitForSelector('.studio-periods');
  assert.equal(await ana.locator('.studio-periods a.seg-locked[href="#plans"]').count(), 1, 'a year of analytics is a Pro feature');
  await ana.goto(BASE + '#coach');
  await ana.waitForSelector('.coach-locked');
  step('community mode: Free by default, paid plans shown but not on sale, Pro features locked');

  // ——— A moderator grants Pro; the server-side limits follow ———
  await mod.goto(BASE + '#admin');
  await mod.waitForSelector('#admin-plans');
  await mod.fill('#plan-search', 'ana');
  await mod.click('[data-act=plan-search]');
  await mod.waitForSelector('[data-act=plan-grant]');
  await mod.locator('.grant-row', { hasText: 'Ana Sousa' }).locator('select').selectOption('pro');
  await mod.locator('.grant-row', { hasText: 'Ana Sousa' }).locator('input[placeholder^=Note]').fill('Beta tester');
  await mod.locator('.grant-row', { hasText: 'Ana Sousa' }).locator('[data-act=plan-grant]').click();
  await toastSays(mod, /Plan granted/);
  await mod.waitForFunction(() => /Artist Pro · granted/.test((document.querySelector('#admin-plans')?.textContent || '')));
  await ana.goto(BASE + '#home');
  await ana.reload();
  await ana.goto(BASE + '#plans');
  await ana.waitForFunction(() => /You’re on Artist Pro until .* granted by Abremi/.test(document.querySelector('.plan-status')?.textContent || ''));
  await ana.goto(BASE + '#coach');
  await ana.waitForFunction(() => /60 of 60 requests left/.test(document.querySelector('.coach')?.textContent || ''));
  await ana.goto(BASE + '#studio');
  await ana.waitForSelector('.studio-periods [data-act=studio-days][data-v="365"]');
  await ana.click('.studio-periods [data-act=studio-days][data-v="365"]');
  await ana.waitForSelector('.studio-periods [data-v="365"].is-on');
  const visitor = await open('u-cy@example.com');
  await visitor.goto(BASE + '#artist/m_u-ana@example.com');
  await visitor.waitForSelector('.artist-header h1');
  await visitor.waitForFunction(() => /Pro/.test(document.querySelector('.artist-header h1 .plan-badge')?.textContent || ''));
  assert.match(await visitor.locator('.plan-badge').getAttribute('title'), /doesn’t affect rankings/);
  await ana.goto(BASE + '#plans');
  await ana.click('[data-act=plan-badge][aria-pressed=true]');
  await toastSays(ana, /badge is hidden/);
  await visitor.reload();
  await visitor.waitForSelector('.artist-header h1');
  await visitor.waitForTimeout(500);
  assert.equal(await visitor.locator('.artist-header .plan-badge').count(), 0, 'hidden when the artist chooses');
  await ana.click('[data-act=plan-badge][aria-pressed=false]');
  await toastSays(ana, /badge is shown/);
  step('a moderator grants Pro: the Coach allowance, a year of analytics and the badge follow from the server');

  // ——— Gallery accounts ———
  await visitor.goto(BASE + '#plans');
  await visitor.waitForSelector('#gallery-account');
  await visitor.click('#gallery-account [data-act=gallery-open]');
  await visitor.fill('#gal-name', 'Casa do Mar');
  await visitor.fill('#gal-city', 'Porto');
  await visitor.fill('#gal-country', 'pt');
  await visitor.fill('#gal-website', 'http://casadomar.example');
  await visitor.click('[data-act=gallery-submit]');
  assert.match(await textOf(visitor, '#gal-error'), /https/);
  await visitor.fill('#gal-website', 'https://casadomar.example');
  await visitor.fill('#gal-bio', 'A gallery by the sea.');
  await visitor.click('[data-act=gallery-submit]');
  await toastSays(visitor, /moderator will check it/);
  await mod.click('[data-act=admin-reload]');
  await mod.waitForSelector('[data-act=gallery-review][data-v=verify]');
  await mod.click('[data-act=gallery-review][data-v=verify]');
  await toastSays(mod, /Gallery verified/);
  await mod.waitForFunction(() => !document.querySelector('[data-act=gallery-review]')); // the page has refreshed
  await mod.fill('#plan-search', 'Cy');
  await mod.click('[data-act=plan-search]');
  await mod.waitForSelector('.grant-row select option[value=gallery]', { state: 'attached' });
  await mod.locator('.grant-row', { hasText: 'Cy Park' }).locator('select').selectOption('gallery');
  await mod.locator('.grant-row', { hasText: 'Cy Park' }).locator('[data-act=plan-grant]').click();
  await toastSays(mod, /Plan granted/);
  await visitor.goto(BASE + '#home');
  await visitor.reload();
  await visitor.goto(BASE + '#opportunities');
  await visitor.waitForSelector('[data-act=opportunity-suggest]');
  await visitor.click('[data-act=opportunity-suggest]');
  await visitor.fill('#op-title', 'Winter Residency');
  await visitor.fill('#op-organizer', 'Casa do Mar');
  await visitor.fill('#op-location', 'Porto');
  await visitor.fill('#op-link', 'https://casadomar.example/winter');
  await visitor.click('[data-act=opportunity-submit]');
  await toastSays(visitor, /Published/);
  await visitor.waitForSelector('.opportunity .verified-mark');
  await visitor.click('.opportunity a[href^="#gallery/"]');
  await visitor.waitForSelector('.gallery-page');
  assert.match(await textOf(visitor, '.gallery-page'), /Casa do Mar.*Porto.*A gallery by the sea.*Winter Residency/s);
  assert.equal(await visitor.locator('.gallery-page a[target=_blank]').first().getAttribute('rel'), 'noopener noreferrer nofollow');
  step('galleries apply, a moderator verifies them, and on the Gallery plan their listings publish directly');

  // ——— Invite-only sign-up ———
  await mod.click('[data-act=invite-required][data-v=on]');
  await toastSays(mod, /need an invite code/);
  await mod.waitForSelector('[data-act=invite-required][data-v=off]'); // the page has refreshed
  await mod.fill('#invite-uses', '1');
  await mod.click('[data-act=invite-create]');
  await toastSays(mod, /Invite code [A-Z2-9]{10} created/);
  const code = (await textOf(mod, '#admin-beta .invite-code')).trim();
  const guest = await open(null);
  await guest.goto(BASE + '#profile');
  await guest.waitForSelector('.account-card [data-act=sign-in]');
  await guest.click('.account-card [data-act=sign-in]');
  await guest.waitForSelector('#auth-invite');
  await guest.fill('#auth-email', 'newbie@example.com');
  await guest.fill('#auth-invite', 'WRONGCODE2');
  await guest.click('[data-act=send-link]');
  await guest.waitForFunction(() => /isn’t valid/.test(document.querySelector('.auth .form-error')?.textContent || ''));
  await guest.fill('#auth-invite', code.toLowerCase());
  await guest.click('[data-act=send-link]');
  await guest.fill('#auth-code', '123456');
  await guest.click('[data-act=verify-code]');
  await guest.waitForFunction(() => document.querySelector('#nav-profile .avatar'));
  await mod.click('[data-act=admin-reload]');
  await mod.waitForFunction(() => /1 of 1 used/.test((document.querySelector('#admin-beta')?.textContent || '')));
  await mod.click('[data-act=invite-required][data-v=off]');
  await toastSays(mod, /Sign-ups are open/);
  step('invite-only sign-up: a wrong code is refused, a valid one works once, and sign-ups can be reopened');

  // ——— Feedback and the error log ———
  await ana.goto(BASE + '#profile');
  await ana.click('.profile-foot [data-act=feedback-open]');
  await ana.waitForSelector('#feedback-form');
  await ana.click('[data-act=feedback-kind][data-v=idea]');
  await ana.fill('#feedback-message', 'Let me sort my collections by date.');
  await ana.click('[data-act=feedback-submit]');
  await toastSays(ana, /Thank you/);
  await ana.evaluate(() => setTimeout(() => { throw new Error('Boom from the e2e test'); }, 0));
  await ana.waitForFunction(() => (window.__mockdb.load().clientErrors || []).some((e) => /Boom/.test(e.message)));
  await mod.click('[data-act=admin-reload]');
  await mod.waitForFunction(() => /Let me sort my collections/.test((document.querySelector('#admin-beta')?.textContent || '')));
  assert.match(await textOf(mod, '#admin-beta .error-list'), /Boom from the e2e test/);
  await mod.locator('#admin-beta [data-act=feedback-resolve]').first().click();
  await toastSays(mod, /Resolved/);
  step('members send feedback (Profile, footer or phone menu); app errors reach the moderators’ log; feedback can be resolved');

  await mod.setViewportSize({ width: 390, height: 844 });
  await mod.goto(BASE + '#home');
  await mod.click('[data-act=toggle-menu]');
  assert.equal(await mod.locator('#menu a[href="#plans"]').count(), 1);
  await mod.click('#menu [data-act=feedback-open]');
  await mod.waitForSelector('#feedback-form');
  await mod.keyboard.press('Escape');
  await mod.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await mod.locator('.footer-links a[href="#opportunities"]').count(), 1, 'desktop reaches Opportunities and Plans from the footer');

  // ——— Phones ———
  for (const p of [ana, mod]) await p.setViewportSize({ width: 390, height: 844 });
  for (const [p, hash] of [[ana, '#plans'], [mod, '#admin'], [visitor, '#opportunities']]) {
    if (p === visitor) await p.setViewportSize({ width: 390, height: 844 });
    await p.goto(BASE + hash);
    await p.waitForTimeout(400);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth), 390, `${hash} fits a phone`);
  }
  step('Plans, moderation and Opportunities fit a phone screen');

  assert.deepEqual(errors, []);
  console.log('All Phase 6 e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
