import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatures, classifyStyle, guessMedium, similarArtists } from '../src/core/recognition.js';

function image(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y);
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return data;
}

test('flat muted image reads as Minimalism', () => {
  const f = extractFeatures(image(40, 40, (x, y) => (y < 20 ? [120, 100, 95] : [90, 95, 120])), 40, 40);
  assert.ok(f.edgeDensity < 0.05);
  assert.equal(classifyStyle(f)[0].name, 'Minimalism');
});

test('grayscale image is detected as B&W photography', () => {
  const f = extractFeatures(image(40, 40, (x) => [x * 6, x * 6, x * 6]), 40, 40);
  assert.ok(f.grayscale > 0.9);
  assert.equal(guessMedium(f).id, 'photography');
});

test('busy saturated multi-hue image has high texture and variety', () => {
  const palette = [[255, 0, 0], [0, 200, 0], [0, 0, 255], [255, 220, 0], [255, 0, 200]];
  const f = extractFeatures(image(40, 40, (x, y) => palette[(x * 7 + y * 13) % 5]), 40, 40);
  assert.ok(f.edgeDensity > 0.5);
  assert.ok(f.saturation > 0.8);
  assert.ok(f.hueVariety >= 5 / 12);
});

test('confidences sum to 1 and similar artists share the style', () => {
  const f = extractFeatures(image(10, 10, () => [200, 50, 50]), 10, 10);
  const styles = classifyStyle(f);
  assert.ok(Math.abs(styles.reduce((s, x) => s + x.confidence, 0) - 1) < 1e-9);
  const artists = [{ id: 'a', styles: [styles[0].name], category: 'oil' }, { id: 'b', styles: ['Nothing'], category: 'x' }];
  const sim = similarArtists(artists, styles, { id: 'oil' });
  assert.equal(sim[0].artist.id, 'a');
  assert.ok(!sim.some((s) => s.artist.id === 'b'));
});
