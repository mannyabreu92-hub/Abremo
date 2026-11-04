// Artwork Recognition (on-device prototype).
// Take a photo → extract visual features from pixels → guess style + medium → find similar artists.
// In production this is a vision-model call; the interface (features → prediction → matches) stays the same.

/** data: RGBA Uint8ClampedArray-like, width × height. */
export function extractFeatures(data, width, height) {
  const n = width * height;
  let sumL = 0, sumS = 0, gray = 0;
  const hueBins = new Array(12).fill(0);
  const lum = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sumL += lum[i];
    sumS += s;
    if (s < 0.12) gray++;
    else {
      let h;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      hueBins[Math.floor(h / 30) % 12]++;
    }
  }

  let edges = 0, edgeSamples = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i = y * width + x;
      const gx = Math.abs(lum[i] - lum[i + 1]);
      const gy = Math.abs(lum[i] - lum[i + width]);
      if (gx + gy > 0.12) edges++;
      edgeSamples++;
    }
  }

  const colored = n - gray;
  const usedHues = hueBins.filter((c) => colored > 0 && c / colored > 0.04).length;
  const warm = colored ? (hueBins[0] + hueBins[1] + hueBins[11] + hueBins[10]) / colored : 0;

  return {
    brightness: sumL / n,
    saturation: sumS / n,
    grayscale: gray / n,
    hueVariety: usedHues / 12,
    warmth: warm,
    edgeDensity: edgeSamples ? edges / edgeSamples : 0,
  };
}

const STYLE_PROFILES = {
  Impressionism: { saturation: 0.45, hueVariety: 0.5, edgeDensity: 0.35, brightness: 0.6 },
  Expressionism: { saturation: 0.65, hueVariety: 0.45, edgeDensity: 0.25, warmth: 0.55 },
  Abstract: { saturation: 0.55, hueVariety: 0.35, edgeDensity: 0.12 },
  Minimalism: { saturation: 0.3, hueVariety: 0.15, edgeDensity: 0.03 },
  'Pop Art': { saturation: 0.85, hueVariety: 0.4, edgeDensity: 0.3, brightness: 0.6 },
  Realism: { saturation: 0.3, hueVariety: 0.3, edgeDensity: 0.15, grayscale: 0.3 },
  Surrealism: { saturation: 0.4, hueVariety: 0.25, edgeDensity: 0.08, brightness: 0.45 },
  Cubism: { saturation: 0.35, hueVariety: 0.25, edgeDensity: 0.28, warmth: 0.5 },
  Futurism: { saturation: 0.6, hueVariety: 0.3, edgeDensity: 0.4, brightness: 0.3 },
  Vaporwave: { saturation: 0.7, hueVariety: 0.3, edgeDensity: 0.1, warmth: 0.2, brightness: 0.5 },
};

function distance(features, profile) {
  let d = 0, k = 0;
  for (const [key, target] of Object.entries(profile)) {
    d += (features[key] - target) ** 2;
    k++;
  }
  return Math.sqrt(d / k);
}

function softmax(scores, temperature = 0.08) {
  const exps = scores.map((s) => Math.exp(-s / temperature));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}

export function classifyStyle(features) {
  const names = Object.keys(STYLE_PROFILES);
  const probs = softmax(names.map((n) => distance(features, STYLE_PROFILES[n])));
  return names.map((name, i) => ({ name, confidence: probs[i] })).sort((a, b) => b.confidence - a.confidence);
}

export function guessMedium(features) {
  if (features.grayscale > 0.7) return { id: 'photography', label: 'Photography (B&W)' };
  if (features.saturation > 0.7 && features.edgeDensity < 0.15) return { id: 'digital', label: 'Digital art' };
  if (features.edgeDensity > 0.3 && features.saturation > 0.35) return { id: 'oil', label: 'Painting (textured)' };
  if (features.saturation < 0.25 && features.edgeDensity < 0.12) return { id: 'sculpture', label: 'Sculpture / object' };
  if (features.edgeDensity > 0.2) return { id: 'street', label: 'Street art / graphic' };
  return { id: 'mixed', label: 'Mixed media' };
}

/**
 * artists: [{ id, styles: [...], category }], scores: id → artist score.
 * @param {(artist: any) => number} [scoreOf]
 */
export function similarArtists(artists, styleRanking, medium, scoreOf = () => 0, limit = 5) {
  const top = styleRanking.slice(0, 3);
  return artists
    .map((a) => {
      let m = 0;
      for (const s of top) if (a.styles.includes(s.name)) m += s.confidence;
      if (a.category === medium.id) m += 0.25;
      return { artist: a, match: m };
    })
    .filter((x) => x.match > 0)
    .sort((x, y) => y.match - x.match || scoreOf(y.artist) - scoreOf(x.artist))
    .slice(0, limit);
}
