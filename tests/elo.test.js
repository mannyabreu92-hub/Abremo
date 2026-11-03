import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedScore, battleResult, kFactor, pickBattlePair } from '../src/core/elo.js';
import { mulberry32 } from '../src/core/random.js';

test('expected scores are symmetric', () => {
  assert.equal(expectedScore(1200, 1200), 0.5);
  assert.ok(Math.abs(expectedScore(1400, 1200) + expectedScore(1200, 1400) - 1) < 1e-12);
});

test('winner gains, loser loses fewer points', () => {
  for (const [w, l] of [[1200, 1200], [1100, 1500], [1500, 1100], [1300, 1290]]) {
    const r = battleResult(w, l);
    assert.ok(r.gain > 0);
    assert.ok(r.loss < r.gain, `loss ${r.loss} should be < gain ${r.gain}`);
    assert.equal(r.winner, w + r.gain);
    assert.equal(r.loser, l - r.loss);
  }
});

test('upsets pay more than expected wins', () => {
  assert.ok(battleResult(1100, 1500).gain > battleResult(1500, 1100).gain);
  assert.equal(battleResult(1100, 1500).upset, true);
});

test('heavier roles move ratings more', () => {
  assert.ok(kFactor('collector') > kFactor('critic'));
  assert.ok(kFactor('critic') > kFactor('artist'));
  assert.ok(kFactor('artist') > kFactor('fan'));
  assert.ok(battleResult(1200, 1200, 'collector').gain > battleResult(1200, 1200, 'fan').gain);
});

test('battle pairs never pit an artist against themselves', () => {
  const works = [
    { id: '1', artistId: 'a' }, { id: '2', artistId: 'a' }, { id: '3', artistId: 'b' }, { id: '4', artistId: 'c' },
  ];
  const rng = mulberry32(7);
  for (let i = 0; i < 200; i++) {
    const [x, y] = pickBattlePair(works, rng);
    assert.notEqual(x.artistId, y.artistId);
  }
});
