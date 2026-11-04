// End-to-end test of artist uploads: community mode (stand-in backend) and demo mode.
// Needs a running server (npm start) and Playwright:  node tests/e2e/uploads.e2e.cjs [baseUrl]
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const BASE = process.argv[2] || 'http://localhost:5173/';
const mock = readFileSync(path.join(__dirname, 'mock-cloud.js'), 'utf8');
const PHOTO = path.join(__dirname, '..', '..', 'icons', 'screenshot-wide.jpg'); // 1920 × 1200 JPEG
const step = (name) => console.log(`✓ ${name}`);

async function signIn(page, email) {
  await page.goto(BASE + '#profile');
  await page.waitForSelector('.account-card');
  await page.click('[data-act=sign-in]');
  await page.fill('#auth-email', email);
  await page.click('[data-act=send-link]');
  await page.fill('#auth-code', '123456');
  await page.click('[data-act=verify-code]');
  await page.waitForFunction((e) => document.querySelector('.account-card')?.textContent.includes(e) || document.querySelector('#nav-profile .avatar'), email);
}

async function signOut(page) {
  await page.goto(BASE + '#profile');
  await page.click('[data-act=sign-out]');
  await page.waitForFunction(() => document.querySelector('#nav-profile')?.textContent.includes('Sign in'));
}

async function fillStudio(page, { title, category = 'photography', style = 'Minimalism', price = '650' }) {
  await page.setInputFiles('#upload input[type=file]', PHOTO);
  await page.fill('#upload [name=title]', title);
  await page.selectOption('#upload [name=category]', category);
  await page.selectOption('#upload [name=style]', style);
  await page.fill('#upload [name=price]', price);
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(mock);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  const db = () => page.evaluate(() => window.__mockdb.load());

  await signIn(page, 'eve@example.com');
  await page.goto(BASE + '#profile');
  assert.equal(await page.locator('#upload').count(), 0, 'fans have no studio');
  await page.click('[data-act=set-role][data-v=artist]');
  await page.waitForSelector('#upload');
  step('the studio appears once you choose the Artist role');

  await page.click('#upload-submit');
  assert.match(await page.locator('#upload-status').textContent(), /Choose a photo/);
  await page.setInputFiles('#upload input[type=file]', PHOTO);
  await page.waitForSelector('#upload-preview:not([hidden])');
  await page.click('#upload-submit');
  assert.match(await page.locator('#upload-status').textContent(), /title/);
  step('the form explains what is missing');

  await fillStudio(page, { title: 'Night Bloom' });
  await page.click('#upload-submit');
  await page.waitForFunction(() => /live for everyone/.test(document.querySelector('#toast').textContent));
  let d = await db();
  assert.equal(d.uploads.length, 1);
  const up = d.uploads[0];
  assert.equal(up.image_type, 'image/webp');
  assert.deepEqual([up.width, up.height], [1600, 1000]);
  assert.ok(up.image_bytes < 5 * 1024 * 1024);
  assert.match(up.thumb_path, /^data:image\/webp/);
  await page.waitForSelector('.work-row');
  assert.match(await page.locator('.work-row').first().textContent(), /Night Bloom/);
  step(`published: resized to 1600×1000 WebP (${Math.round(up.image_bytes / 1024)} KB) with a thumbnail`);

  await page.goto(BASE + '#explore');
  await page.selectOption('#explore-sort', 'new');
  await page.waitForFunction(() => document.querySelector('.art-grid .art-title')?.textContent.includes('Night Bloom'));
  assert.match(await page.locator('.art-grid .art-card img').first().getAttribute('src'), /^data:image\/webp/);
  step('the work appears in Explore (newest first), using the thumbnail');

  await signOut(page);
  await signIn(page, 'ben@example.com');
  await page.goto(BASE + '#explore');
  await page.selectOption('#explore-sort', 'new');
  await page.waitForFunction(() => document.querySelector('.art-grid .art-title')?.textContent.includes('Night Bloom'));
  await page.locator('.art-grid .art-card').first().hover();
  await page.locator('.art-grid .quick-btn[data-v=like]').first().click();
  await page.waitForTimeout(300);
  d = await db();
  assert.ok(d.reactions.some((r) => r.artwork_id === up.id && r.user_id === 'u-ben@example.com' && r.kind === 'like'));
  await page.locator('.art-grid .art-card .art-title button').first().click();
  await page.waitForSelector('#sheet.open .detail-grid');
  assert.equal(await page.locator('#sheet [data-act=delete-artwork]').count(), 0, 'no delete on other people’s work');
  await page.click('#sheet .artist-line');
  await page.waitForSelector('.artist-page .art-grid');
  assert.match(page.url(), /#artist\/m_u-eve%40example\.com$|#artist\/m_u-eve@example\.com$/);
  assert.match(await page.locator('.artist-page').textContent(), /Night Bloom/);
  assert.equal(await page.locator('#sheet.open').count(), 0, 'the artwork sheet closes when the artist page opens');
  step('another member sees it, can like it, and finds it on the artist’s page');

  await signOut(page);
  await signIn(page, 'eve@example.com');
  await page.goto(BASE + '#profile');
  await page.waitForSelector('.work-row');
  await page.click('.work-row [data-act=delete-artwork]');
  await page.waitForFunction(() => /Deleted/.test(document.querySelector('#toast').textContent));
  d = await db();
  assert.equal(d.uploads.length, 0);
  assert.ok(!d.reactions.some((r) => r.artwork_id === up.id));
  await page.goto(BASE + '#explore');
  await page.selectOption('#explore-sort', 'new');
  await page.waitForTimeout(300);
  assert.ok(!(await page.locator('.art-grid').textContent()).includes('Night Bloom'));
  step('the artist deletes it: gone for everyone, likes included');

  // Demo mode (no backend): uploads stay on the device.
  const demo = await (await browser.newContext()).newPage();
  demo.on('pageerror', (e) => errors.push(e.message));
  demo.on('dialog', (dlg) => dlg.accept());
  await demo.goto(BASE + '#profile');
  await demo.click('[data-act=set-role][data-v=artist]');
  await demo.waitForSelector('#upload');
  await fillStudio(demo, { title: 'Local Study', category: 'oil', style: 'Realism', price: '120' });
  await demo.click('#upload-submit');
  await demo.waitForSelector('.work-row');
  const local = await demo.evaluate(() => JSON.parse(localStorage.getItem('abremi:v1')).uploads[0]);
  assert.equal(local.title, 'Local Study');
  assert.match(local.thumb, /^data:image\/webp/);
  await demo.click('.work-row [data-act=delete-artwork]');
  await demo.waitForFunction(() => !document.querySelector('.work-row'));
  step('demo mode: upload and delete on this device');

  assert.deepEqual(errors, []);
  console.log('All upload e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
