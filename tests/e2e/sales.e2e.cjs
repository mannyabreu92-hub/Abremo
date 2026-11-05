// End-to-end test of checkout (migration 0017) against the stand-in backend, with Stripe stood in:
// off by default; artists set up payouts; collectors buy originals and edition prints; the artist
// ships with tracking; the buyer confirms delivery and can report a problem; a moderator decides.
// Needs a running server (npm start) and Playwright:  node tests/e2e/sales.e2e.cjs [baseUrl]
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
    p.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'The frame arrived cracked in one corner.' : undefined));
    await p.addInitScript((u) => sessionStorage.setItem('mockcloud-session', JSON.stringify({ id: u, email: u.slice(2) })), user);
    return p;
  };
  const signedIn = (p) => p.waitForFunction(() => /Signed in/.test(document.querySelector('.account-card')?.textContent || ''));

  const ana = await open('u-ana@example.com');
  await ana.goto(BASE + '#profile');
  await signedIn(ana);
  await ana.evaluate(() => {
    const d = window.__mockdb.load();
    const old = new Date(Date.now() - 30 * 864e5).toISOString();
    d.admins = ['u-mod@example.com'];
    d.profiles['u-cy@example.com'] = { id: 'u-cy@example.com', name: 'Cy Park', country: 'KR', role: 'fan', created_at: old, public_leaderboards: true };
    window.__mockdb.save(d);
  });
  await ana.click('[data-act=set-role][data-v=artist]');
  for (const [title, price] of [['Harbour', '900'], ['Tideline', '120']]) {
    await ana.waitForSelector('#upload');
    await ana.setInputFiles('#upload input[type=file]', PHOTO);
    await ana.fill('#upload [name=title]', title);
    await ana.fill('#upload [name=price]', price);
    await ana.click('#upload-submit');
    await ana.waitForFunction((t) => [...document.querySelectorAll('#studio .work-row')].some((r) => r.textContent.includes(t)), title);
  }
  const ids = await ana.evaluate(() => Object.fromEntries(window.__mockdb.load().uploads.map((u) => [u.title, u.id])));

  // ——— Off by default ———
  const cy = await open('u-cy@example.com');
  await cy.goto(BASE + `#art/${ids.Harbour}`);
  await cy.waitForSelector('[data-act=offer-open]');
  assert.equal(await cy.locator('[data-act=checkout-buy]').count(), 0, 'no Buy while sales are off');
  await ana.goto(BASE + '#orders');
  await ana.waitForFunction(() => /isn’t switched on yet/.test(document.querySelector('.orders-page')?.textContent || ''));
  step('buying is off until switched on');

  // ——— The artist sets up payouts ———
  await ana.evaluate(() => { const d = window.__mockdb.load(); (d.settings ||= {}).sales_enabled = true; window.__mockdb.save(d); });
  await ana.reload();
  await ana.goto(BASE + '#orders');
  await ana.waitForSelector('[data-act=payouts-setup]');
  await ana.selectOption('#payout-country', 'US');
  await ana.click('[data-act=payouts-setup]');
  await ana.waitForFunction(() => location.hash.includes('payouts=done'));
  await ana.reload();
  await ana.waitForFunction(() => /Payouts are ready/.test(document.querySelector('.orders-page')?.textContent || ''));
  assert.equal((await ana.evaluate(() => window.__mockdb.load().payouts['u-ana@example.com'].country)), 'US', 'the country typed is the one sent');
  await ana.evaluate((id) => { const d = window.__mockdb.load(); d.uploads.find((u) => u.id === id).edition_size = 2; window.__mockdb.save(d); }, ids.Tideline);
  step('an artist sets up payouts with Stripe (stood in)');

  // ——— Buying an original and a print ———
  await cy.reload();
  await cy.goto(BASE + `#art/${ids.Harbour}`);
  await cy.waitForSelector('[data-act=checkout-buy]');
  assert.match(await cy.locator('[data-act=checkout-buy]').textContent(), /Buy · \$900/);
  await cy.click('[data-act=checkout-buy]');
  await cy.waitForFunction(() => location.hash.startsWith('#orders'));
  await toastSays(cy, /Payment received/);
  await cy.waitForFunction(() => /Paid · to ship.*Harbour/s.test(document.querySelector('.orders-page')?.textContent || ''));
  await cy.goto(BASE + `#art/${ids.Tideline}`);
  await cy.waitForSelector('[data-act=checkout-buy]');
  assert.match(await cy.locator('#view').textContent(), /edition of 2 · 2 left/);
  assert.match(await cy.locator('[data-act=checkout-buy]').textContent(), /Buy a print · \$120/);
  await cy.click('[data-act=checkout-buy]');
  await cy.waitForFunction(() => location.hash.startsWith('#orders'));
  const editions = await cy.evaluate((id) => window.__mockdb.load().uploads.find((u) => u.id === id), ids.Tideline);
  assert.deepEqual([editions.editions_sold, editions.availability || 'available'], [1, 'available'], 'one print sold, still for sale');
  step('a collector buys an original and a numbered print');

  // ——— Shipping, delivery, a problem, a decision ———
  await ana.reload();
  await ana.goto(BASE + '#orders');
  await ana.waitForSelector('.order-card [data-act=order-ship]');
  assert.match(await ana.locator('.order-card').first().textContent(), /Ship to:/);
  const first = ana.locator('.order-card', { hasText: 'Harbour' });
  await first.locator('input[id^=ship-carrier]').fill('DHL');
  await first.locator('input[id^=ship-tracking]').fill('JD0146000');
  await first.locator('[data-act=order-ship]').click();
  await toastSays(ana, /Marked as shipped/);
  await cy.reload();
  await cy.goto(BASE + '#orders');
  await cy.waitForSelector('[data-act=order-delivered]');
  assert.match(await cy.locator('.orders-page').textContent(), /DHL JD0146000/);
  await cy.click('[data-act=order-delivered]');
  await toastSays(cy, /Enjoy your work/);
  await cy.locator('.order-card', { hasText: 'Harbour' }).locator('[data-act=order-dispute]').click();
  await toastSays(cy, /A moderator will be in touch/);
  const mod = await open('u-mod@example.com');
  await mod.goto(BASE + '#admin');
  await mod.waitForSelector('#admin-disputes [data-act=dispute-resolve]');
  assert.match(await mod.locator('#admin-disputes').textContent(), /frame arrived cracked/);
  await mod.fill('#admin-disputes input', 'Refund approved after photos.');
  await mod.click('#admin-disputes [data-act=dispute-resolve][data-v=refund]');
  await toastSays(mod, /Decision recorded/);
  step('the artist ships with tracking; the buyer confirms delivery and reports a problem; a moderator decides');

  // ——— Verified artist and certificates of authenticity ———
  await mod.goto(BASE + '#artist/m_u-ana@example.com');
  await mod.waitForSelector('[data-act=toggle-verified][data-v=family]');
  await mod.click('[data-act=toggle-verified][data-v=family]');
  await mod.waitForSelector('.artist-header .verified-badge');
  assert.match(await mod.locator('.verified-note').textContent(), /managed by the artist’s family/);
  await cy.goto(BASE + '#orders');
  await cy.waitForSelector('.orders-page a[href^="#certificate/ABR-"]');
  const certHref = await cy.locator('.order-card', { hasText: 'Tideline' }).locator('a[href^="#certificate/ABR-"]').getAttribute('href');
  const voidHref = await cy.locator('.order-card', { hasText: 'Harbour' }).locator('a[href^="#certificate/ABR-"]').getAttribute('href');
  const code = certHref.split('/')[1];
  assert.match(code, /^ABR-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  await cy.click(`.orders-page a[href="${certHref}"]`);
  await cy.waitForSelector('.certificate');
  const certText = await cy.locator('.certificate-page').textContent();
  assert.match(certText, /Genuine/);
  assert.match(certText, /Certificate of authenticity[\s\S]*Verified/);
  assert.ok(certText.includes(code));
  assert.match(certText, /Print 1 of 2/);
  await cy.goto(BASE + voidHref);
  await cy.waitForFunction(() => /void: the sale was refunded/.test(document.querySelector('.cert-status')?.textContent || ''));
  // Anyone can check a code, signed in or not, and it never shows the buyer.
  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await guestCtx.addInitScript(mock);
  const guest = await guestCtx.newPage();
  guest.on('pageerror', (e) => errors.push(e.message));
  await guest.goto(BASE + '#certificate');
  await guest.evaluate((db) => localStorage.setItem('mockcloud', db), await cy.evaluate(() => localStorage.getItem('mockcloud')));
  await guest.reload();
  await guest.waitForSelector('#cert-code');
  await guest.fill('#cert-code', code.toLowerCase());
  await guest.click('[data-act=certificate-check]');
  await guest.waitForSelector('.certificate');
  const shown = await guest.locator('.certificate-page').textContent();
  assert.ok(!shown.includes('cy@example.com') && !/Lisbon/.test(shown), 'never the buyer or their address');
  assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth), 390);
  await guest.goto(BASE + '#certificate/ABR-0000-0000-0000');
  await guest.waitForSelector('.certificate-check [role=alert]');
  assert.match(await guest.locator('[role=alert]').textContent(), /No certificate has this code/);
  await guestCtx.close();
  step('moderators verify artists (✓ badge); every sale has a printable certificate anyone can check');

  assert.deepEqual(errors, []);
  console.log('All checkout e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
