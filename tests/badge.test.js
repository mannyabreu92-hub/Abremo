// The Abremi Index badge (api/badge.js), with a stand-in database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { badgeSVG, chartLabel, createBadge } from '../api/badge.js';

test('chart labels read naturally', () => {
  assert.equal(chartLabel('overall'), 'Overall');
  assert.equal(chartLabel('medium:oil'), 'Oil Painting');
  assert.equal(chartLabel('country:US'), 'United States');
});

test('the badge shows the rank, chart and week; unranked artists get a plain badge', () => {
  const svg = badgeSVG({ rank: 3, chart: 'medium:photography', covers_from: '2026-11-02' });
  assert.match(svg, /^<svg /);
  assert.match(svg, /#3 · Photography/);
  assert.match(svg, /Week of Nov 2, 2026/);
  assert.match(badgeSVG(null), /On Abremi/);
});

test('text is escaped and only the public key is used; bad ids are refused', async () => {
  assert.doesNotMatch(badgeSVG({ rank: 1, chart: 'medium:<script>', covers_from: '2026-11-02' }), /<script>/);
  const calls = [];
  const badge = createBadge({
    fetchImpl: async (url, init) => { calls.push(init.headers.Authorization); return Response.json({ rank: 2, chart: 'overall', covers_from: '2026-11-02' }); },
    supabaseUrl: 'https://db.example.co', supabaseKey: 'pk',
  });
  const ok = await badge('m_abc');
  assert.equal(ok.status, 200);
  assert.match(ok.body, /#2 · Overall/);
  assert.deepEqual(calls, ['Bearer pk']);
  assert.equal((await badge('"><x')).status, 400);
  const down = createBadge({ fetchImpl: async () => { throw new Error('offline'); }, supabaseUrl: 'https://db.example.co', supabaseKey: 'pk' });
  assert.match((await down('m_abc')).body, /On Abremi/, 'never a broken image');
});
