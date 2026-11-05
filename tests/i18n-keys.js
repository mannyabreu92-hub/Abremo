// Every English text the translated screens can show, collected from the source. Used by
// tests/i18n.test.js (every language must have all of them) and by `node tests/i18n-keys.js`
// (prints the list, for translators).
import { readFileSync } from 'node:fs';
import { CATEGORIES, STYLES } from '../src/core/seed.js';
import { ROLES } from '../src/core/scoring.js';
import { SIGNALS } from '../src/core/insights.js';
import { AVAILABILITY } from '../src/core/community.js';
import { INQUIRY_KINDS } from '../src/ui/views/radar.js';
import { STEPS } from '../src/ui/views/launch.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const STR = String.raw`'((?:\\.|[^'\\])*)'`;
const unq = (s) => s.replace(/\\'/g, "'");

/** The app.js functions that make up the translated screens. */
export const APP_FUNCTIONS = ['nudgeSignIn', 'masterpieceHTML', 'renderHome', 'footerHTML', 'langPickerHTML', 'swipeCardHTML', 'discoverPanelHTML',
  'renderDiscover', 'applySwipe', 'artworkSheet', 'renderArtworkPage', 'contactSheet', 'renderExplore', 'renderArtistPage', 'renderArtists',
  'emergingHTML', 'searchResultsHTML', 'renderOrders', 'renderCertificate', 'sendLink', 'verifyCode'];
/** View files that are translated in full. */
export const VIEW_FILES = ['src/ui/views/orders.js', 'src/ui/views/certificate.js', 'src/ui/views/launch.js'];

function functionSource(src, name) {
  const start = src.search(new RegExp(String.raw`\n(async )?function ${name}\(`));
  if (start < 0) throw new Error(`app.js: function ${name} not found`);
  const rest = src.slice(start + 1);
  const end = rest.search(/\n(async )?function |\n\/\/ ———|\nconst [A-Za-z]+ = /);
  return rest.slice(0, end < 0 ? undefined : end);
}

/** Text passed to the helpers that translate on their own (buttons, headers, empty states, toasts). */
function autoKeys(src) {
  const keys = [];
  const grab = (re, group = 1) => { for (const m of src.matchAll(re)) keys.push(unq(m[group])); };
  grab(new RegExp(String.raw`PremiumButton\(${STR}`, 'g'));
  grab(new RegExp(String.raw`PremiumButton\([^'\`]*\? ${STR} : ${STR}`, 'g'));
  grab(new RegExp(String.raw`PremiumButton\([^'\`]*\? ${STR} : ${STR}`, 'g'), 2);
  grab(new RegExp(String.raw`IconButton\('[a-zA-Z]+', ${STR}`, 'g'));
  grab(new RegExp(String.raw`toast\(${STR}`, 'g'));
  grab(new RegExp(String.raw`toast\([^;]*?\|\| ${STR}`, 'g'));
  for (const m of src.matchAll(/(EmptyState|SectionHeader)\(\{([^}]*)\}/g)) {
    for (const f of m[2].matchAll(new RegExp(String.raw`(?:title|body|eyebrow): ${STR}`, 'g'))) keys.push(unq(f[1]));
    for (const f of m[2].matchAll(new RegExp(String.raw`(?:title|body|eyebrow): [^,]*\? ${STR} : ${STR}`, 'g'))) keys.push(unq(f[1]), unq(f[2]));
    for (const f of m[2].matchAll(new RegExp(String.raw`(?:title|body|eyebrow): [^,]*\? ${STR} : [^,]*\? ${STR} : [^,]*\? ${STR} : ${STR}`, 'g'))) keys.push(...[1, 2, 3, 4].map((i) => unq(f[i])));
  }
  return keys;
}

/** Explicit t('…') and tn(n, '…', '…') calls. */
function tKeys(src) {
  const keys = [];
  for (const m of src.matchAll(new RegExp(String.raw`\bt\(${STR}`, 'g'))) keys.push(unq(m[1]));
  for (const m of src.matchAll(new RegExp(String.raw`\btn\([^,]+, ${STR}, ${STR}`, 'g'))) keys.push(unq(m[1]), unq(m[2]));
  return keys;
}

export function collectKeys() {
  const app = read('src/ui/app.js');
  const keys = new Set();
  const add = (list) => { for (const k of list) if (k && /[A-Za-z]/.test(k)) keys.add(k); };
  // Every explicit t() in the code base is a key; helper text only in the translated screens.
  for (const f of ['src/ui/app.js', 'src/ui/components.js', 'src/ui/views/account.js', 'src/ui/views/radar.js', ...VIEW_FILES]) add(tKeys(read(f)));
  for (const name of APP_FUNCTIONS) add(autoKeys(functionSource(app, name)));
  for (const f of VIEW_FILES) add(autoKeys(read(f)));
  const account = read('src/ui/views/account.js');
  add(autoKeys(account.slice(account.indexOf('export function signInHTML'), account.indexOf('export function accountCardHTML') + 900)));
  const radar = read('src/ui/views/radar.js');
  add(autoKeys(radar.slice(radar.indexOf('export function inquirySheet'), radar.indexOf('export function inboxPage'))));
  // Text from data, translated where it is shown.
  add(CATEGORIES.map((c) => c.label));
  add(STYLES);
  add(ROLES.map((r) => r.label));
  add(['Critic reviews', 'Contemporary']);
  add(Object.values(SIGNALS).flatMap((s) => [s.label, s.desc]));
  add(Object.values(AVAILABILITY));
  add(Object.values(INQUIRY_KINDS).map((k) => k.label));
  add(STEPS.flatMap((s) => [s.eyebrow, s.title, s.body]));
  add([...app.matchAll(/^const SORTS = \{[\s\S]*?^\};/gm)].flatMap((m) => [...m[0].matchAll(new RegExp(String.raw`label: ${STR}`, 'g'))].map((x) => unq(x[1]))));
  add([...app.matchAll(/^const DISCOVER_LABELS = \{.*\};/gm)].flatMap((m) => [...m[0].matchAll(new RegExp(STR, 'g'))].map((x) => unq(x[1]))));
  add([...app.matchAll(new RegExp(String.raw`Object\.assign\(auth, \{ error: ${STR}`, 'g'))].map((m) => unq(m[1])));
  add([...app.matchAll(new RegExp(String.raw`certificateCheckHTML\(\{ code, error: ${STR}`, 'g'))].map((m) => unq(m[1])));
  add([...app.matchAll(new RegExp(String.raw`error: data \? '' : ${STR}`, 'g'))].map((m) => unq(m[1])));
  add([...app.matchAll(new RegExp(String.raw`\.catch\(\(e\) => certs\.set\(code, \{ error: e\?\.message \|\| ${STR}`, 'g'))].map((m) => unq(m[1])));
  // Why Discover shows a work (src/core/feed.js).
  const feed = read('src/core/feed.js');
  add([...feed.matchAll(new RegExp(String.raw`\? ${STR} : ${STR}`, 'g'))].flatMap((m) => [unq(m[1]), unq(m[2])]));
  const orders = read('src/ui/views/orders.js');
  add([...orders.matchAll(/^const STATUS = \{.*\};/gm)].flatMap((m) => [...m[0].matchAll(new RegExp(String.raw`: ${STR}`, 'g'))].map((x) => unq(x[1]))));
  const cert = read('src/ui/views/certificate.js');
  add([...cert.matchAll(new RegExp(String.raw`row\(${STR}`, 'g'))].map((m) => unq(m[1])));
  const launch = read('src/ui/views/launch.js');
  for (const m of launch.matchAll(new RegExp(String.raw`benefit\('[a-z]+', ${STR}, ${STR}\)`, 'g'))) add([unq(m[1]), unq(m[2])]);
  // The page shell (index.html): text and labels marked for translation.
  const html = read('index.html');
  add([...html.matchAll(/data-i18n>([^<]+)</g)].map((m) => m[1].trim()));
  add([...html.matchAll(/data-i18n-(?:aria-label|title)="([^"]+)"/g)].map((m) => m[1]));
  // Messages from the server that buyers can see.
  add(['Purchased', 'This artist can’t take payments yet. Ask them about it instead.', 'Someone is already buying this work', 'This edition is sold out',
    'This work isn’t for sale at a listed price', 'That’s your own work', 'Sign in first']);
  return [...keys].sort();
}

/** {placeholders} in a text. */
export const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  for (const k of collectKeys()) console.log(k);
}
