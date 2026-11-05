import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_COUNTRY_CODES, flagOf } from '../src/core/countries.js';
import { COUNTRIES } from '../src/core/seed.js';

test('profiles can choose any country, including every sample country and the Dominican Republic', () => {
  assert.ok(ALL_COUNTRY_CODES.length > 230);
  assert.equal(new Set(ALL_COUNTRY_CODES).size, ALL_COUNTRY_CODES.length, 'no duplicates');
  assert.ok(ALL_COUNTRY_CODES.every((c) => /^[A-Z]{2}$/.test(c)), 'the database accepts two capital letters');
  for (const c of [...COUNTRIES.map((x) => x.code), 'DO', 'PR', 'AR', 'CO', 'CN']) assert.ok(ALL_COUNTRY_CODES.includes(c), c);
  for (const c of ALL_COUNTRY_CODES) assert.ok(new Intl.DisplayNames(['en'], { type: 'region' }).of(c), c);
  assert.equal(flagOf('DO'), '🇩🇴');
  assert.equal(flagOf(''), '');
});
