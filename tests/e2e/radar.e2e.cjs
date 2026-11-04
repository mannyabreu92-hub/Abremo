// End-to-end test of Phase 4 against the stand-in backend: real inquiries in place of simulated
// purchases (conversation, unread state, decline), new-account limits, collector interest in the
// Studio, and Drops (hidden until release, teaser, Notify me, release announcement).
// Needs a running server (npm start) and Playwright:  node tests/e2e/radar.e2e.cjs [baseUrl]
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
    p.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Spam test') : d.accept()));
    await p.addInitScript((u) => sessionStorage.setItem('mockcloud-session', JSON.stringify({ id: u, email: u.slice(2) })), user);
    return p;
  };
  const publish = async (p, title) => {
    await p.goto(BASE + '#profile');
    await p.waitForSelector('#upload');
    await p.setInputFiles('#upload input[type=file]', PHOTO);
    await p.fill('#upload [name=title]', title);
    await p.fill('#upload [name=price]', '900');
    const before = await p.locator('#studio .work-row').count();
    await p.click('#upload-submit');
    await p.waitForFunction((n) => document.querySelectorAll('#studio .work-row').length > n, before);
  };

  // ——— An artist with a work; a collector (account older than 3 days) ———
  const ana = await open('u-ana@example.com');
  await ana.goto(BASE + '#profile');
  await ana.waitForFunction(() => /Signed in/.test(document.querySelector('.account-card')?.textContent || ''));
  await ana.click('[data-act=set-role][data-v=artist]');
  await ana.waitForSelector('#upload');
  await publish(ana, 'Harbour');
  const db = () => ana.evaluate(() => window.__mockdb.load());
  const work = (await db()).uploads[0].id;
  await ana.evaluate(() => {
    const d = window.__mockdb.load();
    d.profiles['u-ben@example.com'] = { id: 'u-ben@example.com', name: 'Ben Okafor', country: 'GB', role: 'collector', created_at: new Date(Date.now() - 30 * 864e5).toISOString() };
    window.__mockdb.save(d);
  });

  const ben = await open('u-ben@example.com');
  await ben.goto(BASE + `#art/${work}`);
  await ben.waitForSelector('.artwork-page [data-act=buy]');
  assert.doesNotMatch(await ben.locator('.artwork-page').textContent(), /Purchase/, 'no simulated purchase');
  await ben.click('.artwork-page [data-act=buy]');
  await ben.waitForSelector('#inquiry-form');
  assert.equal(await ben.locator('#inquiry-kind').inputValue(), 'purchase');
  assert.match(await ben.locator('#inquiry-form').textContent(), /Your email isn’t shared/);
  await ben.fill('#inquiry-message', 'Hi');
  await ben.click('[data-act=send-inquiry]');
  assert.match(await ben.locator('#inquiry-error').textContent(), /at least 10/);
  await ben.fill('#inquiry-message', 'Is Harbour still available? I collect coastal work.');
  await ben.click('[data-act=send-inquiry]');
  await toastSays(ben, /artist has been notified/);
  await ben.waitForSelector('.thread .message.is-mine');
  step('Inquire opens a real conversation (no simulated purchase), with validation and privacy notes');

  // ——— The artist replies; unread state; decline ———
  await ana.goto(BASE + '#inbox');
  await ana.reload();
  await ana.waitForSelector('.inquiry-row.is-unread');
  assert.match(await ana.locator('.inquiry-row').textContent(), /Ben Okafor.*Verified collector.*Interested in buying · Harbour/s);
  assert.equal(await ana.locator('#menu-inbox').textContent(), 'Inbox (1)');
  await ana.click('.inquiry-row');
  await ana.waitForSelector('.thread .message');
  await ana.fill('#reply-body', 'Yes it is. 60 × 80 cm, oil on linen.');
  await ana.click('[data-act=send-reply]');
  await ana.waitForFunction(() => document.querySelectorAll('.thread .message.is-mine').length === 1);
  let d = await db();
  assert.equal(d.inquiries[0].artist_unread, false, 'read when opened');
  assert.equal(d.inquiries[0].sender_unread, true);
  assert.ok(d.notifications.some((n) => n.user_id === 'u-ben@example.com' && n.kind === 'inquiry_reply'));
  await ana.click('[data-act=inquiry-status][data-v=declined]');
  await ana.waitForFunction(() => /Declined by the artist/.test(document.querySelector('.thread')?.textContent || ''));
  await ben.goto(BASE + '#inbox');
  await ben.reload();
  await ben.click('[data-act=inbox-tab][data-v=sent]');
  await ben.waitForSelector('.inquiry-row');
  await ben.click('.inquiry-row');
  await ben.waitForSelector('.thread .message');
  assert.equal(await ben.locator('#reply-form').count(), 0, 'no replies once declined');
  step('the artist sees it in the Inbox (unread), replies, and declines; the collector can’t reply after');

  // ——— New accounts wait 3 days ———
  const cy = await open('u-cy@example.com');
  await cy.goto(BASE + `#art/${work}`);
  await cy.waitForSelector('.artwork-page [data-act=buy]');
  await cy.click('.artwork-page [data-act=buy]');
  await cy.fill('#inquiry-message', 'Hello, is this one still available?');
  await cy.click('[data-act=send-inquiry]');
  await cy.waitForFunction(() => /after 3 days/.test(document.querySelector('#inquiry-error')?.textContent || ''));
  step('accounts under 3 days old can’t send inquiries');

  // ——— Collector interest in the Studio ———
  await ana.goto(BASE + '#studio');
  await ana.reload();
  await ana.waitForSelector('.works-table');
  assert.match(await ana.locator('.works-table thead').textContent(), /Inquiries/);
  assert.match((await ana.locator('.works-table tbody tr').first().textContent()).replace(/\s+/g, ' '), /Harbour/);
  step('the Studio shows inquiries and collector saves per work');

  // ——— Drops ———
  await ben.goto(BASE + '#artist/m_u-ana@example.com');
  await ben.waitForSelector('.artist-header [data-act=follow]');
  await ben.click('.artist-header [data-act=follow]');
  await publish(ana, 'Night Swim');
  const nightSwim = (await db()).uploads.find((u) => u.title === 'Night Swim').id;
  await ana.click('#studio [data-act=open-drop-form]');
  await ana.waitForSelector('#drop-form');
  await ana.fill('#drop-title', 'Summer Night');
  await ana.fill('#drop-description', 'New paintings of the sea after dark.');
  await ana.check(`#drop-form input[name=drop-work][value="${nightSwim}"]`);
  await ana.click('[data-act=create-drop]');
  await toastSays(ana, /Drop scheduled/);
  await ana.waitForSelector('.drop-page [data-act=drop-cancel]');
  assert.match(await ana.locator('.drop-page').textContent(), /Only you can see these works until the release/);
  d = await db();
  const dropId = d.drops[0].id;
  assert.ok(d.notifications.some((n) => n.user_id === 'u-ben@example.com' && n.kind === 'drop_announced'), 'followers hear about it');
  await ben.goto(BASE + `#drop/${dropId}`);
  await ben.waitForSelector('.drop-page .drop-teaser.is-veiled');
  assert.equal(await ben.locator('.drop-page .art-card').count(), 0, 'works stay secret');
  await ben.click('[data-act=drop-subscribe]');
  await toastSays(ben, /notify you at the release/);
  const snap = await ben.evaluate(async () => (await window.__abremiCloud()).snapshot());
  assert.equal(snap.uploads.some((u) => u.id === nightSwim), false, 'left out of the public catalog until release');
  await ben.goto(BASE + '#home');
  await ben.waitForSelector('.drops-section .drop-card');
  step('an artist schedules a drop; followers are told; the works stay hidden behind a veiled teaser; Notify me works');

  await ana.evaluate((id) => {
    const db2 = window.__mockdb.load();
    const past = new Date(Date.now() - 1000).toISOString();
    db2.drops.find((x) => x.id === id).release_at = past;
    for (const u of db2.uploads) if (u.drop_id === id) u.release_at = past;
    window.__mockdb.save(db2);
  }, dropId);
  await ben.goto(BASE + `#drop/${dropId}`);
  await ben.reload();
  await ben.waitForSelector('.drop-page .art-card');
  assert.match(await ben.locator('.drop-page').textContent(), /Night Swim/);
  d = await db();
  assert.equal(d.notifications.filter((n) => n.user_id === 'u-ben@example.com' && n.kind === 'drop_released').length, 1, 'announced once');
  step('at the release the works appear and followers and subscribers are notified once');

  assert.deepEqual(errors, []);
  console.log('All Collector Radar and Drops e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
