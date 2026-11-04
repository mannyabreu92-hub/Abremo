// End-to-end test of the ABREMI experience: discovery, influence feedback, achievements, Taste Score,
// collections, rankings, artist pages, Art Battles and the Daily Masterpiece (demo mode).
// Needs a running server (npm start) and Playwright:  node tests/e2e/culture.e2e.cjs [baseUrl]
const { chromium, devices } = require('playwright');
const assert = require('node:assert/strict');

const BASE = process.argv[2] || 'http://localhost:5173/';
const step = (name) => console.log(`✓ ${name}`);

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const [label, opts] of [['desktop', { viewport: { width: 1280, height: 860 } }], ['phone', { ...devices['iPhone 13'] }]]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
    page.on('dialog', (d) => d.accept());
    const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('abremi:v1')));

    // Home: the Daily Masterpiece is real, stable and counting down.
    await page.goto(BASE);
    await page.waitForSelector('.hero .display-hero');
    assert.match(await page.locator('.display-hero').textContent(), /Discover Art\.\s*Shape Culture\./);
    const mp1 = await page.locator('.masterpiece .mp-frame').getAttribute('data-id');
    assert.match(await page.locator('.masterpiece .countdown').textContent(), /^\d\d:\d\d:\d\d$/);
    await page.reload();
    await page.waitForSelector('.masterpiece');
    assert.equal(await page.locator('.masterpiece .mp-frame').getAttribute('data-id'), mp1);
    step(`${label}: Daily Masterpiece is stable for the day, with a live countdown`);

    // Discover: gold pills filter by medium.
    await page.goto(BASE + '#discover');
    await page.waitForSelector('.swipe-card.is-top');
    const pills = await page.locator('.pill-row .chip').allTextContents();
    assert.deepEqual(pills.slice(0, 7), ['All', 'Painting', 'Photography', 'Digital Art', 'Sculpture', 'Street Art', 'Mixed Media']);
    await page.click('.pill-row .chip[data-v="photography"]');
    await page.waitForSelector('.pill-row .chip.is-on[data-v="photography"]');
    assert.match(await page.locator('.swipe-card.is-top .swipe-by small').textContent(), /pigment print/);
    await page.click('.pill-row .chip[data-v=""]');
    step(`${label}: category pills filter the deck`);

    // A like shows the influence it added; the first discovery unlocks an achievement.
    await page.waitForSelector('.swipe-card.is-top');
    await page.click('.deck-like');
    await page.waitForSelector('.influence-chip');
    assert.match(await page.locator('.influence-chip').textContent(), /\+1\s*Influence added/);
    await page.waitForSelector('.celebrate');
    assert.match(await page.locator('.celebrate').textContent(), /First Discovery/);
    await page.click('.celebrate');
    await page.waitForSelector('.celebrate', { state: 'detached' });
    step(`${label}: like → “+1 Influence added” and the First Discovery celebration`);

    // Tap a card (no drag) to open details; Enter does the same on desktop.
    await page.waitForSelector('.swipe-card.is-top');
    const box = await page.locator('.swipe-card.is-top .swipe-art').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
    await page.waitForSelector('#sheet.open .detail-grid');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    step(`${label}: tapping the artwork opens its details`);

    // Four more discoveries reveal the Taste Score.
    for (let i = 0; i < 4; i++) {
      await page.waitForSelector('.swipe-card.is-top:not([data-leaving])');
      await page.click(i === 3 ? '.deck-super' : '.deck-like');
      await page.waitForTimeout(420);
    }
    const s = await state();
    assert.equal(Object.keys(s.discoveries).length, 5);
    assert.ok(Object.values(s.discoveries).every((d) => d.rankAt >= 1 && d.influenceAt >= 0));
    await page.goto(BASE + '#collections');
    await page.waitForSelector('.taste-card');
    assert.ok(!(await page.locator('.taste-card').getAttribute('class')).includes('is-locked'));
    assert.match(await page.locator('.taste-ring b').textContent(), /^\d{1,3}$/);
    assert.match(await page.locator('.influence-total').textContent(), /^\d+$/);
    step(`${label}: five discoveries reveal a Taste Score (${await page.locator('.taste-ring b').textContent()})`);

    // Named collections.
    const someId = Object.keys(s.discoveries)[0];
    await page.evaluate((id) => { const b = document.createElement('button'); b.dataset.act = 'add-to-collection'; b.dataset.id = id; document.body.append(b); b.click(); b.remove(); }, someId);
    await page.waitForSelector('#sheet.open [data-act=new-collection]');
    await page.click('#sheet [data-act=new-collection]');
    await page.click('#sheet [data-act=collection-preset][data-v="Hidden Gems"]');
    await page.click('#sheet [data-act=collection-create]');
    await page.waitForSelector('#sheet .pick.is-on');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const cols = (await state()).collections;
    assert.deepEqual([cols[0].name, cols[0].private, cols[0].ids], ['Hidden Gems', true, [someId]]);
    await page.goto(BASE + '#collections');
    await page.waitForSelector('.collection-grid');
    assert.match(await page.locator('.collection-grid').first().textContent(), /Hidden Gems/);
    step(`${label}: named, private collections`);

    // Rankings: global boards, see-all to 100, countries and categories.
    await page.goto(BASE + '#charts');
    await page.waitForSelector('.board');
    assert.equal(await page.locator('.board').first().locator('.rank-list > li').count(), 5);
    await page.locator('.board').first().locator('[data-act=chart-expand]').click();
    assert.equal(await page.locator('.board').first().locator('.rank-list > li').count(), 100);
    assert.equal(await page.locator('.move-new').count(), 0, 'no fabricated movement before a previous hourly chart exists');
    await page.click('.seg-gold [data-v=countries]');
    await page.waitForSelector('[data-act=chart-country]');
    assert.equal(await page.locator('.rank-list > li').count(), 12);
    await page.locator('[data-act=chart-country]').first().click();
    await page.waitForSelector('.board-title');
    await page.click('.seg-gold [data-v=categories]');
    await page.waitForSelector('.pill-row .chip.is-on');
    step(`${label}: rankings — global top 100, Cultural Influence by Country, categories`);

    // Artist page from a ranking row: follow, tabs.
    await page.click('.seg-gold [data-v=global]');
    await page.locator('.board').nth(1).locator('.rank-row').first().click();
    await page.waitForSelector('.artist-page .artist-header');
    assert.match(page.url(), /#artist\//);
    await page.click('.artist-header [data-act=follow]');
    await page.waitForSelector('.artist-header [data-act=follow][aria-pressed=true]');
    await page.click('[data-act=artist-tab][data-v=about]');
    assert.match(await page.locator('.about-spec').textContent(), /Credibility/);
    const follow = Object.values((await state()).followMeta)[0];
    assert.ok(follow.followersAt > 0);
    step(`${label}: artist page — follow (followers recorded for Early Believer), About tab`);

    // Art Battle: vote, then see it in your history.
    await page.goto(BASE + '#battle');
    await page.waitForSelector('.vote-btn');
    assert.deepEqual((await page.locator('.vote-btn').allTextContents()).map((t) => t.trim()), ['Vote Left', 'Vote Right']);
    await page.locator('.vote-btn').nth(1).click();
    await page.waitForSelector('.battle-card.is-won');
    await page.waitForTimeout(1700);
    await page.waitForSelector('.battle-history .rank-row');
    step(`${label}: Art Battle vote recorded in your history`);

    // Achievements on the profile.
    await page.goto(BASE + '#profile');
    await page.waitForSelector('.achievement-grid');
    assert.ok(await page.locator('.achievement-card.is-earned').count() >= 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.equal(overflow, 0, 'no horizontal overflow');
    step(`${label}: achievements gallery`);
    await ctx.close();
  }
  assert.deepEqual(errors, []);
  console.log('All culture e2e checks passed');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
