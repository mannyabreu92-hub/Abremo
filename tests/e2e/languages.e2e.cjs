// End-to-end test of the five languages: the browser's language is picked up, the menu and footer
// switch it, the choice is remembered, and translated screens fit on a phone.
// Needs a running server (npm start) and Playwright:  node tests/e2e/languages.e2e.cjs [baseUrl]
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const BASE = process.argv[2] || 'http://localhost:5173/';
const step = (name) => console.log(`✓ ${name}`);

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && errors.push(m.text())); return p; };
  const text = (p, sel) => p.locator(sel).first().textContent();

  // A Spanish browser opens in Spanish.
  const es = watch(await (await browser.newContext({ locale: 'es-ES', viewport: { width: 390, height: 844 } })).newPage());
  await es.goto(BASE + '#home');
  await es.waitForSelector('.hero-actions');
  assert.equal(await es.evaluate(() => document.documentElement.lang), 'es');
  assert.match(await text(es, '.hero-actions'), /Empieza a explorar/);
  assert.match(await text(es, '.tabbar'), /Descubrir.*Ranking/s);
  assert.equal(await es.evaluate(() => document.documentElement.scrollWidth), 390);
  step('the browser’s language is used on the first visit (Spanish)');

  // Switch to Chinese from the menu; it is remembered after a reload.
  await es.click('#menu-btn');
  await es.click('#menu-lang [data-v=zh]');
  await es.waitForFunction(() => document.documentElement.lang === 'zh-Hans');
  assert.match(await text(es, '.hero-actions'), /开始探索/);
  assert.match(await text(es, '.tabbar'), /发现/);
  await es.reload();
  await es.waitForSelector('.hero-actions');
  assert.match(await text(es, '.hero-actions'), /开始探索/);
  assert.equal(await es.evaluate(() => document.documentElement.scrollWidth), 390);
  step('the menu switches language (Chinese), and the choice is remembered');

  // Discover and an artwork's details, in Chinese.
  await es.goto(BASE + '#discover');
  await es.waitForSelector('.deck-actions');
  assert.match(await text(es, '.deck-actions'), /跳过.*珍藏.*欣赏/s);
  await es.click('.swipe-info');
  await es.waitForSelector('.detail-grid');
  assert.match(await text(es, '.detail-grid'), /年份/);
  assert.equal(await es.evaluate(() => document.documentElement.scrollWidth), 390);
  step('Discover and artwork details are translated');

  // The artist page and the certificate checker, in French and Portuguese, from the footer.
  await es.keyboard.press('Escape');
  await es.goto(BASE + '#home');
  await es.waitForSelector('#footer-lang');
  await es.click('#footer-lang [data-v=fr]');
  await es.waitForFunction(() => document.documentElement.lang === 'fr');
  await es.goto(BASE + '#join');
  await es.waitForSelector('.join-page');
  assert.match(await text(es, '.join-page'), /Soyez découvert pour votre œuvre/);
  await es.goto(BASE + '#home');
  await es.waitForSelector('#footer-lang');
  await es.click('#footer-lang [data-v=pt]');
  await es.waitForFunction(() => document.documentElement.lang === 'pt');
  await es.goto(BASE + '#certificate');
  await es.waitForSelector('.certificate-check');
  assert.match(await text(es, '.certificate-check'), /Verifique um certificado/);
  assert.equal(await es.evaluate(() => document.documentElement.scrollWidth), 390);
  step('the footer switches language (French, Portuguese): #join and certificates are translated');

  // Back to English.
  await es.goto(BASE + '#home');
  await es.waitForSelector('#footer-lang');
  await es.click('#footer-lang [data-v=en]');
  await es.waitForFunction(() => document.documentElement.lang === 'en');
  assert.match(await text(es, '.hero-actions'), /Start Exploring/);
  step('back to English');

  assert.deepEqual(errors, []);
  console.log('All language e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
