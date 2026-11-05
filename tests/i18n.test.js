import test from 'node:test';
import assert from 'node:assert/strict';
import { collectKeys, placeholders } from './i18n-keys.js';
import { t, tn, useDictionary, LANGS } from '../src/ui/i18n.js';
import es from '../src/i18n/es.js';
import fr from '../src/i18n/fr.js';
import pt from '../src/i18n/pt.js';
import zh from '../src/i18n/zh.js';

const DICTS = { es, fr, pt, zh };
const keys = collectKeys();

test('five languages: English plus Spanish, French, Portuguese and Chinese', () => {
  assert.deepEqual(LANGS.map((l) => l.code), ['en', 'es', 'fr', 'pt', 'zh']);
  assert.ok(keys.length > 300, `found ${keys.length} texts`);
});

for (const [code, dict] of Object.entries(DICTS)) {
  test(`${code}: every text on the translated screens is translated, with the same placeholders`, () => {
    const missing = keys.filter((k) => !(k in dict));
    assert.deepEqual(missing, [], `missing in ${code}.js`);
    for (const k of keys) {
      assert.ok(String(dict[k]).trim(), `${code}: empty translation for “${k}”`);
      assert.deepEqual(placeholders(dict[k]), placeholders(k), `${code}: placeholders differ for “${k}”`);
      assert.equal((dict[k].match(/<b>/g) || []).length, (k.match(/<b>/g) || []).length, `${code}: bold markup differs for “${k}”`);
    }
    const unused = Object.keys(dict).filter((k) => !keys.includes(k));
    assert.deepEqual(unused, [], `${code}.js has texts no screen uses`);
  });
}

test('t() translates, fills placeholders, and falls back to English', () => {
  useDictionary('es', es);
  assert.equal(t('Start Exploring'), 'Empieza a explorar');
  assert.equal(t('No. {n} worldwide', { n: 3 }), 'N.º 3 en el mundo');
  assert.equal(tn(1, '{n} work', '{n} works'), '1 obra');
  assert.equal(tn(4, '{n} work', '{n} works'), '4 obras');
  assert.equal(t('Something not translated'), 'Something not translated');
  useDictionary('en', {});
  assert.equal(t('Start Exploring'), 'Start Exploring');
  assert.equal(t('No. {n} worldwide', { n: 3 }), 'No. 3 worldwide');
});
