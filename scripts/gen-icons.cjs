// Renders the app icons and install-screen screenshots with Playwright (dev-only tool).
// Usage: npm start (in another terminal), then: node scripts/gen-icons.cjs [baseUrl]
const { chromium } = require('playwright');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'icons');
const BASE = process.argv[2] || 'http://localhost:5173/';
const FONT = 'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@1,500&display=block';

// The ABREMI symbol (same paths as AbremiSymbol in src/ui/components.js): flat champagne gold, no gradient.
const SYMBOL = '<path d="M15.3 3.2 3.6 28.8h6.2L17.9 9.6z"/><path d="M16.4 3.2h2.1l10 25.6h-2.2z"/><path d="M10.6 20.3h13.4l.6 1.7H10z"/>';

// mode: 'rounded' (transparent corners), 'full' (edge to edge, for iOS), 'maskable' (symbol inside Android's safe zone)
function iconHTML(mode) {
  const radius = mode === 'rounded' ? '22.5%' : '0';
  const size = mode === 'maskable' ? 46 : 58; // % of the icon
  const ring = mode === 'rounded' ? 'box-shadow: inset 0 0 0 calc(var(--s) * .012) rgba(214,173,104,.45);' : '';
  return `<!doctype html><html><head><style>
    html,body{margin:0;background:transparent}
    .i{--s:100vmin;width:100vmin;height:100vmin;border-radius:${radius};overflow:hidden;position:relative;display:grid;place-items:center;${ring}
      background:radial-gradient(ellipse at 30% 18%,rgba(214,173,104,.22),transparent 55%),radial-gradient(ellipse at 85% 90%,rgba(103,84,58,.2),transparent 50%),#08090A}
    svg{width:${size}%;height:${size}%;color:#D6AD68}
  </style></head><body><div class="i"><svg viewBox="0 0 32 32" fill="currentColor">${SYMBOL}</svg></div></body></html>`;
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
    await page.setContent(iconHTML(mode));
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
