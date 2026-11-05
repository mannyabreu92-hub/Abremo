import test from 'node:test';
import assert from 'node:assert/strict';
import { battleStreak, seasonWindow, seasonName } from '../src/core/streak.js';
import { memberBoards } from '../src/core/leaderboards.js';

const NOW = Date.UTC(2026, 10, 20, 15); // 20 November 2026, 15:00 UTC
const ago = (n) => NOW - n * 86_400_000;

test('a vote a day builds the streak; today stays open', () => {
  assert.deepEqual(battleStreak([], NOW), { current: 0, best: 0, today: false, grace_used: false });
  assert.deepEqual(battleStreak([ago(3), ago(2), ago(1)], NOW), { current: 3, best: 3, today: false, grace_used: false });
  assert.deepEqual(battleStreak([ago(2), ago(1), ago(0), ago(0)], NOW), { current: 3, best: 3, today: true, grace_used: false });
});

test('one missed day a week is forgiven; two in a row, or two within a week, end it', () => {
  assert.equal(battleStreak([ago(4), ago(3), ago(1)], NOW).current, 3, 'missed day forgiven');
  assert.equal(battleStreak([ago(4), ago(3), ago(1)], NOW).grace_used, true);
  assert.equal(battleStreak([ago(5), ago(4), ago(1)], NOW).current, 1, 'two days in a row end it');
  assert.equal(battleStreak([ago(6), ago(4), ago(2), ago(1)], NOW).current, 2, 'second miss within the week ends it');
  const long = [...Array(20).keys()].map((d) => d + 1).filter((d) => d !== 4 && d !== 12).map(ago);
  assert.equal(battleStreak(long, NOW).current, 18, 'a miss each week is fine');
  assert.equal(battleStreak([ago(9), ago(8), ago(7), ago(3)], NOW).best, 3, 'best survives a break');
});

test('seasons are calendar months in UTC', () => {
  assert.deepEqual(seasonWindow(NOW), { from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 11, 1) });
  assert.deepEqual(seasonWindow('2026-12-31T23:59:00Z'), { from: Date.UTC(2026, 11, 1), to: Date.UTC(2027, 0, 1) });
  assert.equal(seasonName(NOW), 'November 2026');
});

test('season and medium boards count only what happened within them', () => {
  const profiles = ['a', 'b', 'c'].map((id) => ({ id, name: id.toUpperCase(), country: 'US', role: 'fan', public: true }));
  const season = seasonWindow(NOW);
  const r = (user, artwork, time, medium = 'oil') => ({ user, artwork, kind: 'like', role: 'fan', at: time, time, medium });
  const reactions = [
    ...['w1', 'w2', 'w3'].map((w, i) => r('a', w, ago(40) + i)), // last month
    ...['w1', 'w2', 'w3'].map((w, i) => r('b', w, ago(5) + i)), // this month
    ...['w1', 'w2', 'w3'].map((w, i) => r('c', w, ago(2) + i)),
  ];
  const now = memberBoards({ profiles, reactions, reviews: [] }, { season });
  assert.deepEqual(now.discoverers.map((x) => x.name), ['B', 'C'], 'last month’s likes don’t count this month');
  const last = memberBoards({ profiles, reactions, reviews: [] }, { season: seasonWindow(ago(40)) });
  assert.deepEqual(last.discoverers.map((x) => x.name), ['A']);
  assert.equal(last.discoverers[0].score, 0, 'credit only from what arrived before the season ended');
  assert.deepEqual(memberBoards({ profiles, reactions, reviews: [] }, { medium: 'sculpture' }).discoverers, []);
});
