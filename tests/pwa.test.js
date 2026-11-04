import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { assetList, contentVersion, swSource, indexSource, moduleGraph } from '../scripts/gen-sw.js';

const file = (p) => readFileSync(new URL(`../${p}`, import.meta.url));
const manifest = JSON.parse(file('manifest.webmanifest'));

function pngSize(p) {
  const b = file(p);
  assert.equal(b.toString('ascii', 1, 4), 'PNG', `${p} is a PNG`);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

function jpegSize(p) {
  const b = file(p);
  for (let i = 2; i < b.length;) {
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker === 0xc0 || marker === 0xc2) return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}`;
    i += 2 + len;
  }
  throw new Error(`no JPEG size in ${p}`);
}

test('index.html preloads every module the app imports (run `npm run gen:sw` if this fails)', () => {
  assert.equal(file('index.html').toString('utf8'), indexSource());
  const graph = moduleGraph();
  for (const f of ['src/ui/components.js', 'src/ui/views/membership.js', 'src/core/plans.js', 'src/config.js']) assert.ok(graph.includes(f), f);
  assert.equal(graph.includes('src/ui/app.js'), false, 'the entry loads itself');
  assert.equal(graph.includes('src/vendor/supabase.js'), false, 'the sign-in library loads only when needed');
});

test('sw.js is stamped with the current files (run `npm run gen:sw` if this fails)', () => {
  assert.equal(file('sw.js').toString('utf8'), swSource(contentVersion()));
});

test('precache list covers the whole app shell and nothing else', () => {
  const list = assetList();
  for (const f of list) assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), `${f} exists`);
  for (const must of ['index.html', 'manifest.webmanifest', 'src/ui/app.js', 'src/ui/styles.css', 'src/config.js', 'src/ui/pwa.js', 'icons/icon-192.png']) {
    assert.ok(list.includes(must), `${must} is precached`);
  }
  assert.ok(!list.some((f) => /^(tests|scripts|supabase)\//.test(f)), 'dev files are not precached');
  assert.ok(!list.some((f) => f.includes('screenshot')), 'install screenshots are not precached');
});

test('the version changes when any app file changes', () => {
  const list = assetList();
  assert.notEqual(contentVersion(list), contentVersion(list.slice(1)));
});

test('manifest is installable on Android, iOS and desktop', () => {
  for (const key of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons', 'background_color', 'theme_color', 'id']) {
    assert.ok(manifest[key], `manifest.${key}`);
  }
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.start_url.startsWith(manifest.scope));
  assert.ok(manifest.short_name.length <= 12, 'short name fits under the icon');
  const sizes = manifest.icons.filter((i) => i.purpose === 'any').map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'has a maskable icon for Android');
  for (const icon of manifest.icons) assert.equal(pngSize(icon.src), icon.sizes, icon.src);
  for (const shot of manifest.screenshots) assert.equal(jpegSize(shot.src), shot.sizes, shot.src);
  assert.deepEqual(manifest.screenshots.map((s) => s.form_factor).sort(), ['narrow', 'wide']);
  for (const s of manifest.shortcuts) assert.match(s.url, /^\/#(discover|battle|charts|scan)$/);
  assert.equal(pngSize('icons/apple-touch-icon.png'), '180x180');
});

test('index.html links the manifest and iOS home-screen tags', () => {
  const html = file('index.html').toString('utf8');
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /<meta name="theme-color" content="#08090A">/);
});

test('the service worker never caches live data or sign-in', () => {
  const sw = file('sw.js').toString('utf8');
  assert.match(sw, /supabase\.co'\)[^\n]*return; \/\/ live data: network only/);
  assert.match(sw, /request\.method !== 'GET'\) return/);
});
