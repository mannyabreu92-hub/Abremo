// Renders the app icons and install-screen screenshots with Playwright (dev-only tool).
// Usage: npm start (in another terminal), then: node scripts/gen-icons.cjs [baseUrl]
const { chromium } = require('playwright');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'icons');
const BASE = process.argv[2] || 'http://localhost:5173/';
const FONT = 'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@1,500&display=block';

// mode: 'rounded' (transparent corners), 'full' (edge to edge, for iOS), 'maskable' (glyph inside Android's safe zone)
function iconHTML(mode) {
  const radius = mode === 'rounded' ? '22.5%' : '0';
  const glyph = mode === 'maskable' ? 50 : 64; // % of the icon height
  const ring = mode === 'rounded' ? 'box-shadow: inset 0 0 0 calc(var(--s) * .012) rgba(200,169,107,.45);' : '';
  return `<!doctype html><html><head><link rel="stylesheet" href="${FONT}"><style>
    html,body{margin:0;background:transparent}
    .i{--s:100vmin;width:100vmin;height:100vmin;border-radius:${radius};overflow:hidden;position:relative;${ring}
      background:radial-gradient(ellipse at 30% 18%,rgba(200,169,107,.26),transparent 55%),radial-gradient(ellipse at 85% 90%,rgba(100,110,150,.18),transparent 50%),#08090B}
    .g{position:absolute;inset:0;display:grid;place-items:center;font-family:'Playfair Display',serif;font-style:italic;font-weight:500;
      font-size:calc(var(--s) * ${glyph / 100});line-height:1;color:#C8A96B;padding-bottom:calc(var(--s) * ${mode === 'maskable' ? 0.09 : 0.12})}
  </style></head><body><div class="i"><span class="g">g</span></div></body></html>`;
}

(async () => {
  const browser = await chromium.launch();
  const icons = [
    ['icon-192.png', 192, 'rounded'],
    ['icon-512.png', 512, 'rounded'],
    ['icon-maskable-512.png', 512, 'maskable'],
    ['apple-touch-icon.png', 180, 'full'],
    ['favicon-32.png', 32, 'rounded'],
  ];
  for (const [file, size, mode] of icons) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(iconHTML(mode), { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(OUT, file), omitBackground: mode === 'rounded' });
    await page.close();
    console.log('wrote', file);
  }

  // Install-screen screenshots (Android shows these in the richer install dialog).
  const shots = [
    ['screenshot-narrow.jpg', { width: 390, height: 844 }, 'discover'],
    ['screenshot-wide.jpg', { width: 1280, height: 800 }, 'home'],
  ];
  for (const [file, viewport, view] of shots) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: view === 'discover' ? 2 : 1.5 });
    await page.goto(`${BASE}#${view}`);
    await page.waitForSelector(view === 'discover' ? '.swipe-card.is-top' : '.hero');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 82 });
    await page.close();
    console.log('wrote', file);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
