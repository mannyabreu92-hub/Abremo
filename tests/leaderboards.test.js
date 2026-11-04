import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryScores, memberBoards, MIN_DISCOVERIES } from '../src/core/leaderboards.js';

const r = (user, artwork, at, role = 'fan', kind = 'like') => ({ user, artwork, at, role, kind });

test('discovery rewards liking before others, weighted by who came after', () => {
  const crowd = ['b', 'c', 'd', 'e'];
  const reactions = [];
  for (const [i, art] of ['x', 'y', 'z'].entries()) {
    reactions.push(r('early', art, 0 + i));
    crowd.forEach((u, j) => reactions.push(r(u, art, 10 + j)));
    reactions.push(r('late', art, 100 + i));
  }
  const s = discoveryScores(reactions);
  assert.ok(s.get('early').score > s.get('b').score);
  assert.ok(s.get('b').score > s.get('late').score);
  assert.equal(s.get('late').score, 0, 'nothing came after you');
  // A collector arriving later counts 9×: being early to work collectors later back is worth more.
  const withCollector = discoveryScores([r('scout', 'q', 0), r('col', 'q', 1, 'collector'), r('scout', 'q2', 0), r('fan', 'q2', 1), r('scout', 'q3', 0)]);
  assert.ok(withCollector.get('scout').score > 0);
  assert.equal(discoveryScores([r('a', 'x', 0), r('a', 'y', 1)]).get('a').score, null, `needs ${MIN_DISCOVERIES} discoveries`);
  assert.equal(discoveryScores([r('a', 'x', 0, 'fan', 'pass'), r('b', 'x', 1)]).get('a'), undefined, 'passes are not discoveries');
});

test('boards: role-gated, ranked with ties, private members hidden but see themselves', () => {
  const profiles = [
    { id: 'c1', name: 'Ines', country: 'DO', role: 'collector', public: true },
    { id: 'c2', name: 'Ana', country: 'FR', role: 'collector', public: true },
    { id: 'k1', name: 'Kai', country: 'FR', role: 'critic', public: true },
    { id: 'f1', name: 'Fay', country: 'DO', role: 'fan', public: false },
  ];
  const reactions = [r('c1', 'x', 1, 'collector', 'super'), r('c2', 'x', 2, 'collector', 'super'), r('c2', 'y', 3, 'fan'), r('k1', 'x', 4, 'critic')];
  const reviews = [{ user: 'k1', rating: 4 }];
  const anon = memberBoards({ profiles, reactions, reviews });
  assert.deepEqual(anon.collectors.map((x) => [x.rank, x.name, x.score]), [[1, 'Ana', 18], [1, 'Ines', 18]], 'a tie shares the rank; the fan-era like does not count');
  assert.deepEqual(anon.critics.map((x) => [x.name, x.score, x.detail]), [['Kai', 5 + 8, 1]]);
  assert.equal(anon.members, 3);
  assert.deepEqual(anon.me, {});
  assert.deepEqual(memberBoards({ profiles, reactions, reviews }, { country: 'DO' }).collectors.map((x) => x.name), ['Ines']);
  const private4 = memberBoards({ profiles: profiles.map((p) => ({ ...p, role: p.id === 'f1' ? 'collector' : p.role })), reactions: [...reactions, r('f1', 'z', 5, 'collector')], reviews }, { me: 'f1' });
  assert.ok(private4.collectors.some((x) => x.me && x.name === 'Fay'));
  assert.equal(private4.me.collectors.score, 9);
  const someoneElse = memberBoards({ profiles: profiles.map((p) => ({ ...p, role: p.id === 'f1' ? 'collector' : p.role })), reactions: [...reactions, r('f1', 'z', 5, 'collector')], reviews }, { me: 'c1' });
  assert.ok(!someoneElse.collectors.some((x) => x.name === 'Fay'), 'private members are hidden from others');
  assert.ok(!JSON.stringify(anon).includes('"id"'), 'no ids in the output');
});
