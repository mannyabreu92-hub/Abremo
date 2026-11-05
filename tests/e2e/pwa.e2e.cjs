// End-to-end test of the installable app: offline start, update prompt, iPhone install guide.
// Needs a running server (npm start) and Playwright:  node tests/e2e/pwa.e2e.cjs [baseUrl]
const { chromium, devices } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let restoreSw = () => {};

const BASE = process.argv[2] || 'http://localhost:5173/';
const step = (name) => console.log(`✓ ${name}`);

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(BASE);
  await page.waitForSelector('.hero');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 });
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const shell = keys.find((k) => k.startsWith('abremi-shell-'));
    return { shell, count: (await (await caches.open(shell)).keys()).length };
  });
  assert.ok(cached.count >= 20, `precached ${cached.count} files`);
  step(`service worker installed and precached ${cached.count} files (${cached.shell})`);

  const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
  assert.equal(manifest.short_name, 'Abremi');
  step('manifest is linked and served');

  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('.hero', { timeout: 10000 });
  await page.goto(BASE + '#discover');
  await page.waitForSelector('.swipe-card.is-top');
  await page.click('.deck-like');
  await page.waitForTimeout(500);
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('is-offline')));
  step('opens and works with no connection');
  await context.setOffline(false);

  // Simulate a new deploy: the server now has a service worker with a different version.
  // (Browsers fetch service worker updates outside the page, so this edits the served file and restores it.)
  const swPath = path.join(__dirname, '..', '..', 'sw.js');
  const original = fs.readFileSync(swPath, 'utf8');
  restoreSw = () => fs.writeFileSync(swPath, original);
  fs.writeFileSync(swPath, original.replace(/const VERSION = '[^']+';/, "const VERSION = 'next-deploy';"));
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForFunction(() => /new version of Abremi/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });
  await Promise.all([page.waitForEvent('load'), page.click('#toast [data-act=pwa-update]')]);
  await page.waitForSelector('.hero, .swipe-card');
  const active = await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('abremi-shell-')));
  restoreSw();
  assert.deepEqual(active, ['abremi-shell-next-deploy']);
  step('a new deploy shows “Refresh”, reloads into the new version and clears the old cache');

  // iPhone: no install prompt API, so Abremi explains Share → Add to Home Screen.
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  const ios = await phone.newPage();
  ios.on('pageerror', (e) => errors.push(e.message));
  await ios.goto(BASE + '#profile');
  await ios.waitForSelector('.install-card');
  await ios.click('.install-card [data-act=pwa-install]');
  await ios.waitForSelector('.install-guide .steps li');
  assert.equal(await ios.locator('.install-guide .steps li').count(), 3);
  await ios.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/ios-install.png` : '/dev/null' }).catch(() => {});
  step('iPhone shows the Add to Home Screen guide');

  // Installed (standalone) mode: no install prompts.
  const installed = await browser.newContext({ ...devices['iPhone 13'] });
  await installed.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
  const app = await installed.newPage();
  await app.goto(BASE + '#profile');
  await app.waitForSelector('.profile');
  assert.equal(await app.locator('.install-card').count(), 0);
  assert.ok(await app.evaluate(() => document.documentElement.classList.contains('is-standalone')));
  step('installed app hides install prompts');

  // Visitors from before the rename keep their likes and collection.
  const legacy = await browser.newContext();
  await legacy.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('gabangi:v1', JSON.stringify({ interactions: { w0: 'super', w5: 'like' }, user: { name: 'Old Friend', role: 'fan', country: 'FR', plan: 'free' } }));
    }
  });
  const old = await legacy.newPage();
  old.on('pageerror', (e) => errors.push(e.message));
  await old.goto(BASE + '#collections');
  await old.waitForFunction(() => /1 work/.test(document.querySelector('.collection-grid')?.textContent || ''));
  const keys = await old.evaluate(() => [localStorage.getItem('gabangi:v1'), JSON.parse(localStorage.getItem('abremi:v1')).user.name]);
  assert.deepEqual(keys, [null, 'Old Friend']);
  step('data saved under the old name moves to Abremi');

  // Old addresses (gabangi.vercel.app, abremi.vercel.app) retire its offline copy so the redirect can work.
  // Simulated on 127.0.0.1 (always a secure context), since the switch only compares hostnames.
  const swPath2 = path.join(__dirname, '..', '..', 'sw.js');
  const current = fs.readFileSync(swPath2, 'utf8');
  assert.match(current, /const RETIRED_HOSTS = \['gabangi\.vercel\.app', 'abremi\.vercel\.app', 'www\.abremi\.app'\];/);
  const asInstalled = current.replace(/const RETIRED_HOSTS = \[[^\]]*\];/, 'const RETIRED_HOSTS = [];');
  const retiring = current.replace(/const RETIRED_HOSTS = \[[^\]]*\];/, "const RETIRED_HOSTS = ['127.0.0.1'];");
  restoreSw = () => fs.writeFileSync(swPath2, current);
  fs.writeFileSync(swPath2, asInstalled); // what phones on the old address installed before
  const oldSite = await (await browser.newContext()).newPage();
  const oldBase = BASE.replace('localhost', '127.0.0.1');
  await oldSite.goto(oldBase);
  await oldSite.waitForSelector('.hero');
  await oldSite.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 });
  assert.ok((await oldSite.evaluate(() => caches.keys())).length > 0);
  fs.writeFileSync(swPath2, retiring); // the deploy that ships the retire switch
  await oldSite.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  // Let the retirement settle (in production the reload then hits the redirect and leaves this address).
  await oldSite.waitForFunction(async () => (await caches.keys()).length === 0, null, { timeout: 15000, polling: 250 });
  await oldSite.waitForTimeout(2500);
  assert.deepEqual(await oldSite.evaluate(() => caches.keys()), []);
  // With no connection, the old address no longer opens a stale offline copy: visitors must reach the server.
  await oldSite.context().setOffline(true);
  const staleCopy = await oldSite.goto(oldBase).then(() => true, () => false);
  await oldSite.context().setOffline(false);
  assert.equal(staleCopy, false, 'no offline copy is served on the retired address');
  restoreSw();
  step('the old address drops its offline copy and service worker');

  assert.deepEqual(errors, []);
  console.log('All app e2e checks passed');
  await browser.close();
})().catch((e) => { restoreSw(); console.error(e); process.exit(1); }).finally(() => restoreSw());
