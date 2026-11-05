// End-to-end test of Phase 1 against the stand-in backend: honest sample catalog, artist profiles,
// artwork details and editing, shareable artwork pages, account collections (private by default,
// shareable when the curator chooses), and the Following feed.
// Needs a running server (npm start) and Playwright:  node tests/e2e/phase1.e2e.cjs [baseUrl]
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const BASE = process.argv[2] || 'http://localhost:5173/';
const mock = readFileSync(path.join(__dirname, 'mock-cloud.js'), 'utf8');
const PHOTO = path.join(__dirname, '..', '..', 'icons', 'screenshot-wide.jpg');
const PORTRAIT = path.join(__dirname, '..', '..', 'icons', 'icon-512.png');
const step = (name) => console.log(`✓ ${name}`);

async function signIn(page, email) {
  await page.goto(BASE + '#profile');
  await page.waitForSelector('.account-card');
  await page.click('.account-card [data-act=sign-in]');
  await page.fill('#auth-email', email);
  await page.click('[data-act=send-link]');
  await page.fill('#auth-code', '123456');
  await page.click('[data-act=verify-code]');
  await page.waitForFunction(() => document.querySelector('#nav-profile .avatar'));
}
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
  // The real Supabase library is served from this site (no CDN) and starts under the strict CSP.
  const plain = await browser.newPage();
  const cspErrors = [];
  plain.on('console', (m) => m.type() === 'error' && cspErrors.push(m.text()));
  plain.on('pageerror', (e) => cspErrors.push(e.message));
  const external = [];
  plain.on('request', (r) => { const u = new URL(r.url()); if (!['localhost', 'example.supabase.co'].includes(u.hostname)) external.push(r.url()); });
  await plain.goto(BASE + '#home');
  await plain.waitForSelector('.home');
  const kind = await plain.evaluate(async () => (await (await import('/src/ui/cloud.js')).createSupabaseCloud('https://example.supabase.co', 'sb_publishable_test')).kind);
  assert.equal(kind, 'supabase');
  assert.deepEqual(external, [], 'no third-party scripts');
  assert.deepEqual(cspErrors, []);
  await plain.close();
  step('the bundled Supabase library loads from this site under the Content-Security-Policy');

  const page = await ctx.newPage();
  watch(page);
  const db = () => page.evaluate(() => window.__mockdb.load());

  // ——— Honest catalog ———
  await page.goto(BASE + '#art/w10');
  await page.waitForSelector('.artwork-page .detail-grid');
  assert.match(await page.locator('.sample-note').textContent(), /Sample artwork/);
  assert.equal(await page.locator('.artwork-page [data-act=buy]').count(), 0, 'sample works are not for sale');
  assert.match(await page.locator('.artwork-page .stat-row').textContent(), /—\s*Worldwide/);
  assert.match(await page.locator('.artwork-page').textContent(), /Not ranked yet/);
  await page.goto(BASE + '#charts');
  await page.waitForSelector('.board');
  assert.match(await page.locator('[data-board=artworks]').textContent(), /Nothing ranked here yet/);
  step('sample works are labelled, not for sale, and unranked until real members act (shareable #art/ page)');

  // ——— A guest makes a collection on this device… ———
  await page.goto(BASE + '#art/w10');
  await page.click('.artwork-page [data-act=add-to-collection]');
  await page.click('#sheet [data-act=new-collection]');
  await page.fill('#collection-name', 'Night skies');
  await page.click('[data-act=collection-create]');
  await toastSays(page, /Created/);
  assert.match(await page.locator('#new-collection-form, #sheet').first().textContent(), /Night skies|Add to collection/);
  await page.keyboard.press('Escape');

  // ——— …then signs in as an artist: the collection moves to the account ———
  await signIn(page, 'ana@example.com');
  await toastSays(page, /moved to your account/);
  let d = await db();
  assert.equal(d.collections.length, 1);
  const col = d.collections[0];
  assert.equal(col.is_private, true, 'private by default');
  assert.deepEqual(d.collectionItems.map((i) => i.artwork_id), ['w10']);
  step('a guest collection moves to the account on sign-in, private');

  // ——— Artist profile ———
  await page.goto(BASE + '#profile');
  await page.click('[data-act=set-role][data-v=artist]');
  await page.waitForSelector('#studio [data-act=edit-artist-profile]');
  await page.click('#studio [data-act=edit-artist-profile]');
  await page.waitForSelector('#artist-profile-form');
  await page.fill('#profile-city', 'Lisbon');
  await page.fill('#profile-bio', 'Painter of Atlantic light.');
  await page.fill('#profile-statement', 'I paint the hour after rain.');
  await page.fill('#profile-website', 'http://ana.example');
  await page.click('[data-act=save-artist-profile]');
  assert.match(await page.locator('#profile-error').textContent(), /https/);
  await page.fill('#profile-website', 'https://ana.example');
  await page.fill('#profile-instagram', '@ana.paints');
  await page.setInputFiles('#portrait-file', PORTRAIT);
  await page.waitForSelector('#portrait-preview img');
  await page.click('[data-act=save-artist-profile]');
  await toastSays(page, /artist profile is updated/);
  d = await db();
  const artist = d.artists['m_u-ana@example.com'];
  assert.equal(artist.city, 'Lisbon');
  assert.equal(artist.instagram, 'ana.paints');
  assert.match(artist.avatar_path, /^data:image\/webp/);
  step('artist profile: validated links, portrait resized to WebP, saved to the server');

  // ——— Publishing with details, then editing ———
  await page.goto(BASE + '#profile');
  await page.setInputFiles('#upload input[type=file]', PHOTO);
  await page.fill('#upload [name=title]', 'After Rain');
  await page.fill('#upload [name=price]', '900');
  await page.fill('#upload [name=dimensions]', '60 × 80 cm');
  await page.fill('#upload [name=description]', 'Oil on linen. The harbour after a storm.');
  await page.click('#upload-submit');
  await toastSays(page, /live for everyone/);
  d = await db();
  const work = d.uploads.find((u) => u.title === 'After Rain');
  assert.equal(work.dimensions, '60 × 80 cm');
  assert.equal(work.description, 'Oil on linen. The harbour after a storm.');
  await page.goto(BASE + `#art/${work.id}`);
  await page.waitForSelector('.artwork-page .artwork-description');
  assert.match(await page.locator('.artwork-page .spec').textContent(), /60 × 80 cm/);
  await page.click('.artwork-page [data-act=edit-artwork]');
  await page.waitForSelector('#artwork-edit-form');
  await page.selectOption('#edit-availability', 'sold');
  await page.click('[data-act=save-artwork]');
  await toastSays(page, /Saved/);
  await page.waitForFunction(() => /Sold/.test(document.querySelector('.artwork-page .spec')?.textContent || ''));
  assert.equal(await page.locator('.artwork-page [data-act=buy]').count(), 0, 'sold works have no inquiry button');
  step('publish with size and description; the owner edits it and marks it sold (artist-reported)');

  // ——— The public artist page ———
  await page.goto(BASE + '#artist/m_u-ana@example.com');
  await page.waitForSelector('.artist-page');
  assert.match(await page.locator('.artist-header').textContent(), /Lisbon/);
  assert.match(await page.locator('.artist-bio').textContent(), /Atlantic light/);
  assert.ok(await page.locator('.artist-portrait img').count(), 'portrait shown');
  await page.click('[data-act=artist-tab][data-v=about]');
  assert.match(await page.locator('.artist-statement').textContent(), /hour after rain/);
  for (const a of await page.locator('.artist-links a').all()) assert.equal(await a.getAttribute('rel'), 'noopener noreferrer nofollow');
  step('the public artist page shows portrait, city, bio, statement and safe links');

  // ——— Another member: private collections stay private; edits are owner-only ———
  const ben = await ctx.newPage();
  watch(ben);
  await ben.addInitScript(() => sessionStorage.setItem('mockcloud-session', JSON.stringify({ id: 'u-ben@example.com', email: 'ben@example.com' })));
  await ben.goto(BASE + `#collection/${col.id}`);
  await ben.waitForFunction(() => /This collection is private/.test(document.querySelector('#view').textContent));
  await ben.goto(BASE + `#art/${work.id}`);
  await ben.waitForSelector('.artwork-page .detail-grid');
  assert.equal(await ben.locator('[data-act=edit-artwork]').count(), 0, 'no edit on other people’s work');
  step('a private collection is hidden from other members; only the owner can edit a work');

  // Ana shares the collection; Ben can now see it, with the curator's name.
  await page.goto(BASE + '#collections');
  await page.click(`[data-act=open-user-collection][data-v="${col.id}"]`);
  await page.click('#sheet [data-act=collection-private]');
  await toastSays(page, /anyone with the link/);
  await page.waitForTimeout(200);
  assert.equal((await db()).collections[0].is_private, false);
  await ben.goto(BASE + `#collection/${col.id}`);
  await ben.reload(); // a fresh visit (cached copies are also refetched after 10 seconds)
  await ben.waitForSelector('.shared-collection');
  assert.match(await ben.locator('.shared-collection .page-head').textContent(), /Night skies/);
  assert.equal(await ben.locator('.shared-collection [data-act=edit-collection]').count(), 0);
  step('once shared, anyone with the link sees the collection; only the curator can edit it');

  // Ana renames it; then deletes it.
  await page.click('#sheet [data-act=edit-collection]');
  await page.fill('#collection-edit-name', 'Blue hours');
  await page.fill('#collection-edit-description', 'Works for the end of the day.');
  await page.click('[data-act=save-collection]');
  await page.waitForTimeout(300);
  d = await db();
  assert.equal(d.collections[0].name, 'Blue hours');
  assert.equal(d.collections[0].description, 'Works for the end of the day.');
  step('the curator renames and describes the collection');

  // ——— Following feed ———
  await ben.goto(BASE + '#artist/m_u-ana@example.com');
  await ben.click('.artist-header [data-act=follow]');
  await ben.waitForTimeout(300);
  await ben.goto(BASE + '#home');
  await ben.click('[data-act=home-mode][data-v=following]');
  await ben.waitForFunction(() => /After Rain/.test(document.querySelector('.home').textContent));
  assert.match(await ben.locator('.home .section h2').filter({ hasText: 'artists you follow' }).first().textContent(), /From artists you follow/);
  step('Home → Following shows new work from followed artists');

  // ——— Signing out takes account collections off the device ———
  await page.goto(BASE + '#profile');
  await page.click('[data-act=sign-out]');
  await page.waitForFunction(() => document.querySelector('#nav-profile')?.textContent.includes('Sign in'));
  const local = await page.evaluate(() => JSON.parse(localStorage.getItem('abremi:v1')).collections);
  assert.deepEqual(local, [], 'account collections are not left on the device');
  step('signing out removes account collections from the device');

  assert.deepEqual(errors, []);
  console.log('All Phase 1 e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
