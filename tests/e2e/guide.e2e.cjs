// End-to-end test of the Abremi Guide (Phase 7) against the stand-in backend. The model is stood in
// by a canned reply, but suggestions and the reference filter are the real server code
// (api/_guide.js); the real request is covered by tests/assistant.test.js.
// Needs a running server (npm start) and Playwright:  node tests/e2e/guide.e2e.cjs [baseUrl]
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
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    p.on('dialog', (d) => d.accept());
    return p;
  };

  // ——— Demo mode: no Guide (it needs accounts) ———
  const demo = watch(await browser.newPage());
  await demo.goto(BASE + '#home');
  await demo.waitForSelector('#view .shell, #view section');
  assert.equal(await demo.locator('#guide-launcher').isVisible(), false);
  step('demo mode: no Guide launcher');

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(mock);
  const open = async (user) => {
    const p = watch(await ctx.newPage());
    if (user) await p.addInitScript((u) => sessionStorage.setItem('mockcloud-session', JSON.stringify({ id: u, email: u.slice(2) })), user);
    return p;
  };

  // ——— Guests: the launcher, signing in, keyboard ———
  const guest = await open(null);
  await guest.goto(BASE + '#home');
  await guest.waitForSelector('#guide-launcher:not([hidden])');
  assert.match(await guest.locator('#guide-launcher').textContent(), /Ask Abremi/);
  await guest.goto(BASE + '#discover');
  await guest.waitForTimeout(300);
  assert.equal(await guest.locator('#guide-launcher').isVisible(), false, 'hidden on the swipe deck');
  await guest.goto(BASE + '#charts');
  await guest.click('#guide-launcher');
  await guest.waitForSelector('#guide:not([hidden])');
  assert.equal(await guest.locator('#guide').getAttribute('role'), 'dialog');
  assert.match(await guest.locator('#guide').textContent(), /Sign in to ask the Guide/);
  await guest.keyboard.press('Escape');
  await guest.waitForSelector('#guide', { state: 'hidden' });
  assert.equal(await guest.evaluate(() => document.activeElement?.id), 'guide-launcher', 'focus goes back to the launcher');
  step('guests see the launcher (not on the swipe deck); the panel asks them to sign in; Escape closes it');

  // ——— A member asks about the page they're on ———
  const cy = await open('u-cy@example.com');
  await cy.goto(BASE + '#profile');
  await cy.waitForFunction(() => /Signed in/.test(document.querySelector('.account-card')?.textContent || ''));
  await cy.evaluate(() => { const d = window.__mockdb.load(); d.follows.push({ user_id: 'u-cy@example.com', artist_id: 'a3', role: 'fan', created_at: new Date().toISOString() }); window.__mockdb.save(d); });
  await cy.reload();
  await cy.goto(BASE + '#artist/a3');
  await cy.waitForSelector('.artist-header');
  await cy.click('#guide-launcher');
  await cy.waitForSelector('#guide [data-act=guide-prompt]');
  const prompts = await cy.locator('#guide [data-act=guide-prompt]').allTextContents();
  assert.ok(prompts.includes('Tell me about this artist'), 'questions about the page you’re on');
  await cy.waitForFunction(() => /30 of 30 messages left today/.test(document.querySelector('#guide').textContent));
  await cy.click('#guide [data-act=guide-prompt]:has-text("Tell me about this artist")');
  await cy.waitForSelector('#guide .guide-msg.is-user');
  await cy.waitForFunction(() => !document.querySelector('#guide .is-streaming') && document.querySelector('#guide .guide-card'));
  const reply = await cy.locator('#guide .guide-msg.is-guide').last().textContent();
  assert.match(reply, /Stand-in reply for visitor\] about this artist: Tell me about this artist/);
  assert.doesNotMatch(reply, /w99999|invented work|\[\[/, 'invented works never appear');
  assert.equal(await cy.locator('#guide .guide-card[data-guide-ref=artwork]').count(), 1);
  assert.equal(await cy.locator('#guide .guide-card[data-guide-ref=artist]').count(), 1);
  assert.match(await cy.locator('#guide .guide-card[data-guide-ref=artist]').textContent(), /you follow them/, 'personalized: an artist you follow');
  assert.match(await cy.locator('#guide .guide-card[data-guide-ref=artwork] .guide-why').textContent(), /\S/, 'each suggestion says why');
  await cy.waitForFunction(() => /29 of 30 messages left today/.test(document.querySelector('#guide').textContent));
  step('a member asks about the artist page they’re on; the reply streams in with explained, real suggestions and the allowance updates');

  // ——— Suggestions lead into the app, and are counted ———
  await cy.click('#guide .guide-card[data-guide-ref=artwork] .guide-card-actions [data-act=artwork]');
  await cy.waitForSelector('#sheet:not([hidden]) .modal-panel');
  assert.ok(await cy.locator('#sheet').isVisible(), 'the work opens above the Guide');
  await cy.keyboard.press('Escape');
  await cy.waitForSelector('#sheet', { state: 'hidden' });
  await cy.click('#guide .guide-card[data-guide-ref=artwork] [data-act=add-to-collection]');
  await cy.click('#sheet [data-act=new-collection]');
  await cy.fill('#collection-name', 'From the Guide');
  await cy.click('#sheet [data-act=collection-create]');
  await toastSays(cy, /Created “From the Guide” with this work/);
  await cy.keyboard.press('Escape'); // back from the collection sheet
  await cy.waitForSelector('#sheet', { state: 'hidden' });
  await cy.click('#guide [data-act=guide-search]');
  await cy.waitForSelector('#search:not([hidden])');
  assert.notEqual(await cy.inputValue('#search-input'), '');
  await cy.waitForTimeout(300); // let the search finish opening
  await cy.keyboard.press('Escape');
  await cy.waitForSelector('#search', { state: 'hidden' });
  assert.ok(await cy.locator('#guide').isVisible(), 'the Guide stays open behind the search on desktop');
  await cy.waitForFunction(() => ['open', 'artwork_click', 'collection_add', 'search'].every((k) => (window.__mockdb.load().guideEvents || []).some((e) => e.kind === k)));
  step('suggestions open works, save to collections and start searches through existing features, and each is counted');

  // ——— Errors, retry, and keyboard sending ———
  await cy.evaluate(() => { window.__guideFail = 'The Guide is busy right now. Please try again in a minute.'; });
  await cy.fill('#guide-input', 'Something calm and minimal?');
  await cy.press('#guide-input', 'Enter');
  await cy.waitForSelector('#guide .guide-error [data-act=guide-retry]');
  assert.match(await cy.locator('#guide .guide-error').textContent(), /busy right now/);
  await cy.click('#guide [data-act=guide-retry]');
  await cy.waitForFunction(() => /Something calm and minimal/.test(document.querySelector('#guide .guide-msg.is-guide:last-of-type')?.textContent || '') && !document.querySelector('#guide .is-streaming'));
  assert.equal(await cy.locator('#guide .guide-error').count(), 0);
  step('Enter sends; a failed reply shows a plain message and Retry works');

  // ——— Modes and permissions ———
  await cy.click('#guide [data-act=guide-mode][data-v=artist]');
  assert.match(await cy.locator('#guide').textContent(), /The artist mode is for artists/);
  await cy.click('#guide [data-act=guide-mode][data-v=collector]');
  await cy.click('#guide [data-act=guide-prompt] >> nth=0');
  await cy.waitForFunction(() => /Stand-in reply for collector/.test(document.querySelector('#guide .guide-log')?.textContent || '') && !document.querySelector('#guide .is-streaming'));
  await cy.click('#guide [data-act=guide-mode][data-v=visitor]');
  assert.ok(await cy.locator('#guide .guide-msg').count() >= 4, 'each mode keeps its own conversation');
  const ana = await open('u-ana@example.com');
  await ana.goto(BASE + '#profile');
  await ana.waitForFunction(() => /Signed in/.test(document.querySelector('.account-card')?.textContent || ''));
  await ana.click('[data-act=set-role][data-v=artist]');
  await ana.waitForSelector('#upload');
  await ana.setInputFiles('#upload input[type=file]', PHOTO);
  await ana.fill('#upload [name=title]', 'Harbour');
  await ana.fill('#upload [name=price]', '900');
  await ana.click('#upload-submit');
  await ana.waitForSelector('#studio .work-row');
  await ana.click('#guide-launcher');
  await ana.click('#guide [data-act=guide-mode][data-v=artist]');
  await ana.click('#guide [data-act=guide-prompt] >> nth=0');
  await ana.waitForFunction(() => /Stand-in reply for artist/.test(document.querySelector('#guide .guide-log')?.textContent || ''));
  step('three modes with separate conversations; the artist mode only for artists');

  // ——— Limits ———
  await Promise.all([ana.close(), guest.close()]); // other tabs share the stand-in's storage and could overwrite it
  await cy.evaluate(() => {
    const d = window.__mockdb.load();
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 30; i++) (d.guide ||= []).push({ user: 'u-cy@example.com', mode: 'visitor', ok: true, day });
    window.__mockdb.save(d);
  });
  await cy.fill('#guide-input', 'One more?');
  await cy.click('#guide [data-act=guide-send]');
  await cy.waitForSelector('#guide .guide-error');
  assert.match(await cy.locator('#guide .guide-error').textContent(), /used today’s 30 messages/);
  assert.equal(await cy.locator('#guide [data-act=guide-retry]').count(), 0, 'no retry for a limit');
  step('the daily allowance is enforced with a clear message');

  // ——— Personalization: set, then reset ———
  await cy.click('#guide [data-act=guide-settings]');
  await cy.waitForSelector('#guide-interests');
  await cy.fill('#guide-interests', 'black-and-white photography');
  await cy.click('#guide [data-act=guide-prefs-save]');
  await toastSays(cy, /Saved/);
  assert.equal(await cy.evaluate(() => window.__mockdb.load().profiles['u-cy@example.com'].assistant_interests), 'black-and-white photography');
  await cy.click('#guide [data-act=guide-settings]');
  await cy.click('#guide [data-act=guide-reset]');
  await toastSays(cy, /Personalization reset/);
  assert.equal(await cy.evaluate(() => window.__mockdb.load().profiles['u-cy@example.com'].assistant_interests), '');
  assert.equal(await cy.evaluate(() => (window.__mockdb.load().guideEvents || []).filter((e) => e.user === 'u-cy@example.com').length), 0, 'reset forgets what you did with suggestions');
  assert.equal(await cy.locator('#guide .guide-msg').count(), 0, 'and clears the conversation');
  step('personalization can be set and reset');

  // ——— Moderators see counts, never conversations ———
  const mod = await open('u-mod@example.com');
  await mod.goto(BASE + '#profile');
  await mod.waitForFunction(() => /Signed in/.test(document.querySelector('.account-card')?.textContent || ''));
  await mod.evaluate(() => { const d = window.__mockdb.load(); d.admins = ['u-mod@example.com']; window.__mockdb.save(d); });
  await mod.reload();
  await mod.goto(BASE + '#admin');
  await mod.waitForSelector('#admin-guide');
  const stats = await mod.locator('#admin-guide').textContent();
  assert.match(stats, /Replies/);
  assert.match(stats, /Conversations are never stored/);
  assert.doesNotMatch(stats, /Tell me about this artist|calm and minimal/, 'no conversation text');
  step('the moderator page shows Guide counts, never conversations');

  // ——— Phones ———
  const phone = await open('u-cy@example.com');
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(BASE + '#charts');
  await phone.waitForSelector('#guide-launcher:not([hidden])');
  const [launch, bar] = await Promise.all([phone.locator('#guide-launcher').boundingBox(), phone.locator('.tabbar').boundingBox()]);
  assert.ok(launch.y + launch.height <= bar.y, 'the launcher sits above the tab bar');
  await phone.click('#guide-launcher');
  await phone.waitForSelector('#guide:not([hidden])');
  const box = await phone.locator('#guide').boundingBox();
  assert.deepEqual([box.x, box.width], [0, 390], 'full screen on a phone');
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 390);
  await phone.goto(BASE + '#plans');
  await phone.waitForSelector('.plans-page');
  assert.match(await phone.locator('.plans-page').textContent(), /30 Abremi Guide messages a day/);
  step('on phones the launcher clears the tab bar and the Guide opens full screen');

  assert.deepEqual(errors, []);
  console.log('All Guide e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
