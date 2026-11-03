// Procedural, original generative artwork for the demo catalog.
// Every artwork renders deterministically from its id, category, style and palette.

import { mulberry32, hashString } from '../core/random.js';

const W = 300;
const H = 400;
const cache = new Map();

const f = (n) => Math.round(n * 10) / 10;
const col = (r, p) => p[Math.floor(r() * p.length)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function linear(id, stops, vertical = true) {
  const s = stops.map((c, i) => `<stop offset="${f((i / (stops.length - 1)) * 100)}%" stop-color="${c}"/>`).join('');
  return `<linearGradient id="${id}" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}">${s}</linearGradient>`;
}

function grain(id, opacity = 0.15) {
  return {
    def: `<filter id="${id}"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>`,
    layer: `<rect width="${W}" height="${H}" filter="url(#${id})" opacity="${opacity}"/>`,
  };
}

// ——— Style generators ———

function dabs(r, p, id) {
  let out = `<defs>${linear(`${id}g`, [p[0], p[1], p[2]])}</defs><rect width="${W}" height="${H}" fill="url(#${id}g)"/>`;
  if (r() < 0.7) out += `<circle cx="${f(60 + r() * 180)}" cy="${f(60 + r() * 80)}" r="${f(22 + r() * 20)}" fill="${p[4]}" opacity="0.9"/>`;
  for (let i = 0; i < 340; i++) {
    const y = r() * H;
    const band = y < H * 0.55 ? [p[1], p[2], p[4]] : [p[2], p[3], p[0]];
    out += `<ellipse cx="${f(r() * W)}" cy="${f(y)}" rx="${f(3 + r() * 7)}" ry="${f(1.5 + r() * 3)}" transform="rotate(${f(r() * 70 - 35)} ${f(r() * W)} ${f(y)})" fill="${col(r, band)}" opacity="${f(0.5 + r() * 0.45)}"/>`;
  }
  return out;
}

function strokes(r, p) {
  let out = `<rect width="${W}" height="${H}" fill="${p[0]}"/>`;
  for (let i = 0; i < 16; i++) {
    const x0 = r() * W, y0 = r() * H, x1 = r() * W, y1 = r() * H;
    out += `<path d="M${f(x0)} ${f(y0)} Q${f(r() * W)} ${f(r() * H)} ${f(x1)} ${f(y1)}" stroke="${col(r, p.slice(1))}" stroke-width="${f(8 + r() * 42)}" stroke-linecap="round" fill="none" opacity="${f(0.7 + r() * 0.3)}"/>`;
  }
  for (let i = 0; i < 40; i++) out += `<circle cx="${f(r() * W)}" cy="${f(r() * H)}" r="${f(1 + r() * 4)}" fill="${col(r, p)}"/>`;
  return out;
}

function shards(r, p) {
  const cols = 5, rows = 7;
  const pts = [];
  for (let y = 0; y <= rows; y++) {
    pts.push([]);
    for (let x = 0; x <= cols; x++) {
      const edgeX = x === 0 || x === cols, edgeY = y === 0 || y === rows;
      pts[y].push([(x / cols) * W + (edgeX ? 0 : (r() - 0.5) * 50), (y / rows) * H + (edgeY ? 0 : (r() - 0.5) * 50)]);
    }
  }
  let out = '';
  const poly = (a, b, c) => `<polygon points="${[a, b, c].map((q) => `${f(q[0])},${f(q[1])}`).join(' ')}" fill="${col(r, p)}" stroke="${p[0]}" stroke-width="1.5"/>`;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const a = pts[y][x], b = pts[y][x + 1], c = pts[y + 1][x], d = pts[y + 1][x + 1];
      out += r() < 0.5 ? poly(a, b, d) + poly(a, d, c) : poly(a, b, c) + poly(b, d, c);
    }
  }
  out += `<circle cx="${f(100 + r() * 100)}" cy="${f(120 + r() * 120)}" r="${f(30 + r() * 30)}" fill="none" stroke="${p[0]}" stroke-width="5"/>`;
  return out;
}

function dreamscape(r, p, id) {
  const hy = 250 + r() * 50;
  const sx = 70 + r() * 160, sy = 90 + r() * 60, sr = 26 + r() * 22;
  return `<defs>${linear(`${id}s`, [p[0], p[1], p[2]])}<radialGradient id="${id}o" cx="35%" cy="35%"><stop offset="0%" stop-color="${p[4]}"/><stop offset="100%" stop-color="${p[3]}"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#${id}s)"/>
<rect y="${f(hy)}" width="${W}" height="${f(H - hy)}" fill="${p[3]}" opacity="0.85"/>
<ellipse cx="${f(sx + 30)}" cy="${f(hy + 30)}" rx="${f(sr * 1.6)}" ry="${f(sr * 0.25)}" fill="#000" opacity="0.35"/>
<circle cx="${f(sx)}" cy="${f(sy)}" r="${f(sr)}" fill="url(#${id}o)"/>
<rect x="${f(180 + r() * 50)}" y="${f(hy - 110)}" width="44" height="110" rx="22" fill="${p[0]}" stroke="${p[4]}" stroke-width="3"/>
<polygon points="${f(202 + r() * 40)},${f(hy)} 300,${f(hy + 40)} 300,${f(hy + 70)}" fill="#000" opacity="0.25"/>
${Array.from({ length: 5 }, () => `<rect x="${f(r() * 260)}" y="${f(r() * hy * 0.8)}" width="${f(8 + r() * 26)}" height="${f(8 + r() * 26)}" fill="${col(r, p)}" transform="rotate(${f(r() * 40 - 20)} 150 200)" opacity="0.85"/>`).join('')}`;
}

function blocks(r, p, id) {
  const n = 2 + Math.floor(r() * 2);
  let out = `<defs><filter id="${id}b"><feGaussianBlur stdDeviation="3"/></filter></defs><rect width="${W}" height="${H}" fill="${p[0]}"/>`;
  let y = 30;
  const span = (H - 60 - (n - 1) * 18) / n;
  for (let i = 0; i < n; i++) {
    const hgt = span * (0.7 + r() * 0.5);
    out += `<rect x="30" y="${f(y)}" width="240" height="${f(Math.min(hgt, H - 30 - y))}" fill="${p[1 + ((i + Math.floor(r() * 3)) % 4)]}" filter="url(#${id}b)" opacity="0.92"/>`;
    y += hgt + 18;
    if (y > H - 50) break;
  }
  return out;
}

function pop(r, p) {
  const bg = col(r, p.slice(2));
  let out = `<rect width="${W}" height="${H}" fill="${bg}"/>`;
  const dot = p[0];
  for (let y = 10; y < H; y += 14) {
    for (let x = (y / 14) % 2 ? 7 : 0; x < W; x += 14) {
      const rr = 1.5 + 3.5 * Math.abs(Math.sin((x + y) / 90));
      out += `<circle cx="${x}" cy="${y}" r="${f(rr)}" fill="${dot}" opacity="0.35"/>`;
    }
  }
  const cx = 150, cy = 190, R = 95 + r() * 20, n = 8 + Math.floor(r() * 6);
  const star = Array.from({ length: n * 2 }, (_, i) => {
    const rad = i % 2 ? R * 0.55 : R;
    const a = (Math.PI * i) / n;
    return `${f(cx + rad * Math.cos(a))},${f(cy + rad * Math.sin(a))}`;
  }).join(' ');
  out += `<polygon points="${star}" fill="${p[4] === bg ? p[1] : p[4]}" stroke="#111" stroke-width="6" stroke-linejoin="round"/>`;
  out += `<circle cx="${cx}" cy="${cy}" r="${f(R * 0.38)}" fill="${p[1]}" stroke="#111" stroke-width="6"/>`;
  return out;
}

function landscape(r, p, id, photo = false) {
  let out = `<defs>${linear(`${id}k`, [p[0], p[1], p[4]])}</defs><rect width="${W}" height="${H}" fill="url(#${id}k)"/>`;
  out += `<circle cx="${f(60 + r() * 180)}" cy="${f(110 + r() * 60)}" r="${f(18 + r() * 18)}" fill="${p[4]}" opacity="0.95"/>`;
  const layers = 4;
  for (let l = 0; l < layers; l++) {
    const base = 200 + l * 38;
    let d = `M0 ${H} L0 ${f(base)}`;
    for (let x = 0; x <= W; x += 20) d += ` L${x} ${f(base - Math.abs(Math.sin(x / (40 + l * 13) + r() * 0.4)) * (60 - l * 10) - r() * 10)}`;
    d += ` L${W} ${H} Z`;
    out += `<path d="${d}" fill="${p[Math.min(3, l)]}" opacity="${f(0.55 + l * 0.15)}"/>`;
  }
  out += `<rect y="345" width="${W}" height="55" fill="${p[0]}" opacity="0.8"/>`;
  for (let i = 0; i < 10; i++) out += `<rect x="${f(r() * W)}" y="${f(350 + r() * 45)}" width="${f(20 + r() * 60)}" height="1.5" fill="${p[4]}" opacity="0.5"/>`;
  if (photo) {
    const g = grain(`${id}n`, 0.18);
    out = `<defs>${g.def}</defs>${out}${g.layer}<rect width="${W}" height="${H}" fill="none" stroke="#fff" stroke-width="0" />`;
  }
  return out;
}

function rays(r, p) {
  let out = `<rect width="${W}" height="${H}" fill="${p[0]}"/>`;
  const vx = 40 + r() * 220, vy = 80 + r() * 240;
  for (let i = 0; i < 70; i++) {
    const a = r() * Math.PI * 2, len = 120 + r() * 300;
    out += `<line x1="${f(vx)}" y1="${f(vy)}" x2="${f(vx + Math.cos(a) * len)}" y2="${f(vy + Math.sin(a) * len)}" stroke="${col(r, p.slice(1))}" stroke-width="${f(0.5 + r() * 4)}" opacity="${f(0.4 + r() * 0.6)}"/>`;
  }
  for (let i = 0; i < 6; i++) out += `<circle cx="${f(vx)}" cy="${f(vy)}" r="${f(30 + i * 34)}" fill="none" stroke="${p[4]}" stroke-width="2" stroke-dasharray="${f(10 + r() * 30)} ${f(8 + r() * 20)}" opacity="0.6"/>`;
  return out;
}

function vapor(r, p, id) {
  let out = `<defs>${linear(`${id}v`, [p[0], p[2], p[3]])}${linear(`${id}u`, [p[4], p[3]])}
<clipPath id="${id}c">${Array.from({ length: 9 }, (_, i) => `<rect x="0" y="${70 + i * 15}" width="${W}" height="${f(15 - i * 1.4)}"/>`).join('')}</clipPath></defs>
<rect width="${W}" height="${H}" fill="url(#${id}v)"/>
<circle cx="150" cy="170" r="${f(80 + r() * 20)}" fill="url(#${id}u)" clip-path="url(#${id}c)"/>
<rect y="240" width="${W}" height="160" fill="${p[0]}"/>`;
  for (let i = 0; i < 9; i++) out += `<line x1="0" y1="${f(240 + i * i * 2.2)}" x2="${W}" y2="${f(240 + i * i * 2.2)}" stroke="${p[3]}" stroke-width="1.5"/>`;
  for (let i = -8; i <= 8; i++) out += `<line x1="150" y1="240" x2="${150 + i * 60}" y2="${H}" stroke="${p[3]}" stroke-width="1.5"/>`;
  return out;
}

// ——— Category generators ———

function sculpture(r, p, id, art) {
  let out = `<defs>${linear(`${id}w`, ['#ecebe7', '#cfcac2'])}<radialGradient id="${id}m" cx="35%" cy="30%"><stop offset="0%" stop-color="${p[4]}"/><stop offset="60%" stop-color="${p[2]}"/><stop offset="100%" stop-color="${p[0]}"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#${id}w)"/><rect y="320" width="${W}" height="80" fill="#b9b2a7"/>
<ellipse cx="150" cy="330" rx="90" ry="10" fill="#000" opacity="0.18"/>
<rect x="95" y="250" width="110" height="80" fill="#f5f3ef" stroke="#a9a198"/>`;
  const fill = `url(#${id}m)`;
  switch (art.style) {
    case 'Minimalism':
      out += `<polygon points="150,120 210,150 150,180 90,150" fill="${p[4]}"/><polygon points="90,150 150,180 150,250 90,220" fill="${p[2]}"/><polygon points="210,150 150,180 150,250 210,220" fill="${p[0]}"/>`;
      break;
    case 'Realism':
      out += `<path d="M95 250 Q100 190 150 185 Q200 190 205 250 Z" fill="${fill}"/><ellipse cx="150" cy="140" rx="38" ry="48" fill="${fill}"/><rect x="138" y="178" width="24" height="16" fill="${p[2]}"/>`;
      break;
    case 'Futurism':
      for (let i = 0; i < 7; i++) out += `<polygon points="150,${f(250 - r() * 20)} ${f(80 + r() * 140)},${f(80 + r() * 100)} ${f(120 + r() * 60)},${f(200 + r() * 40)}" fill="${fill}" opacity="0.9" stroke="${p[0]}" stroke-width="1"/>`;
      break;
    default:
      out += `<ellipse cx="150" cy="170" rx="${f(55 + r() * 15)}" ry="${f(75 + r() * 10)}" fill="${fill}"/><ellipse cx="${f(145 + r() * 10)}" cy="${f(165 + r() * 10)}" rx="${f(16 + r() * 10)}" ry="${f(28 + r() * 10)}" fill="url(#${id}w)"/><rect x="138" y="240" width="24" height="12" fill="${p[0]}"/>`;
  }
  return out;
}

function graffiti(r, p, id, art) {
  let out = `<defs><pattern id="${id}p" width="40" height="20" patternUnits="userSpaceOnUse"><rect width="40" height="20" fill="#8d5a46"/><rect x="1" y="1" width="38" height="8" fill="#a8664e"/><rect x="-19" y="11" width="38" height="8" fill="#9c5e48"/><rect x="21" y="11" width="38" height="8" fill="#a3624b"/></pattern>${linear(`${id}t`, [p[4], p[2], p[3]])}</defs>
<rect width="${W}" height="${H}" fill="url(#${id}p)"/>`;
  for (let i = 0; i < 8; i++) out += `<circle cx="${f(r() * W)}" cy="${f(r() * H)}" r="${f(20 + r() * 50)}" fill="${col(r, p)}" opacity="${f(0.25 + r() * 0.3)}"/>`;
  const word = esc(art.title.split(' ')[0].toUpperCase().slice(0, 7));
  out += `<text x="150" y="215" text-anchor="middle" font-family="Impact, 'Arial Black', sans-serif" font-size="${word.length > 5 ? 54 : 70}" fill="url(#${id}t)" stroke="#111" stroke-width="5" paint-order="stroke" transform="rotate(${f(r() * 14 - 7)} 150 200)">${word}</text>`;
  for (let i = 0; i < 14; i++) {
    const x = 50 + r() * 200, y = 215 + r() * 15, len = 20 + r() * 80;
    out += `<line x1="${f(x)}" y1="${f(y)}" x2="${f(x)}" y2="${f(y + len)}" stroke="${p[2]}" stroke-width="${f(2 + r() * 3)}" stroke-linecap="round"/><circle cx="${f(x)}" cy="${f(y + len)}" r="3" fill="${p[2]}"/>`;
  }
  for (let i = 0; i < 120; i++) out += `<circle cx="${f(r() * W)}" cy="${f(r() * H)}" r="${f(r() * 1.8)}" fill="${col(r, p)}"/>`;
  return out;
}

function pixel(r, p) {
  const gw = 12, gh = 16, cell = W / gw;
  let out = `<rect width="${W}" height="${H}" fill="${p[0]}"/>`;
  const half = Math.ceil(gw / 2);
  const grid = [];
  for (let y = 0; y < gh; y++) {
    grid.push([]);
    for (let x = 0; x < half; x++) {
      const dist = Math.hypot(x - half, (y - gh / 2) * 0.7);
      grid[y].push(r() < 1 - dist / (gw * 0.62) ? col(r, p.slice(1)) : null);
    }
  }
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const c = grid[y][x < half ? x : gw - 1 - x];
      if (c) out += `<rect x="${f(x * cell)}" y="${f(y * (H / gh))}" width="${f(cell + 0.5)}" height="${f(H / gh + 0.5)}" fill="${c}"/>`;
    }
  }
  const ey = Math.floor(gh * 0.4) * (H / gh);
  out += `<rect x="${f(3 * cell)}" y="${f(ey)}" width="${f(cell * 1.5)}" height="${f(cell)}" fill="#fff"/><rect x="${f(7.5 * cell)}" y="${f(ey)}" width="${f(cell * 1.5)}" height="${f(cell)}" fill="#fff"/>`;
  out += `<rect x="${f(3.5 * cell)}" y="${f(ey + cell * 0.3)}" width="${f(cell * 0.7)}" height="${f(cell * 0.7)}" fill="#000"/><rect x="${f(8 * cell)}" y="${f(ey + cell * 0.3)}" width="${f(cell * 0.7)}" height="${f(cell * 0.7)}" fill="#000"/>`;
  return out;
}

function flow(r, p, id) {
  let out = `<defs><filter id="${id}l"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect width="${W}" height="${H}" fill="${p[0]}"/><g filter="url(#${id}l)" fill="none">`;
  const a = 0.008 + r() * 0.02, b = 0.008 + r() * 0.02, phase = r() * 6;
  for (let i = 0; i < 110; i++) {
    let x = r() * W, y = r() * H;
    let d = `M${f(x)} ${f(y)}`;
    for (let s = 0; s < 40; s++) {
      const ang = Math.sin(x * a + phase) * 2 + Math.cos(y * b) * 2;
      x += Math.cos(ang) * 4;
      y += Math.sin(ang) * 4;
      d += ` L${f(x)} ${f(y)}`;
    }
    out += `<path d="${d}" stroke="${col(r, p.slice(1))}" stroke-width="${f(0.6 + r() * 1.6)}" opacity="${f(0.45 + r() * 0.5)}"/>`;
  }
  return `${out}</g>`;
}

function collage(r, p) {
  let out = `<rect width="${W}" height="${H}" fill="${p[4]}"/>`;
  for (let i = 0; i < 9; i++) {
    const w = 60 + r() * 140, h = 50 + r() * 140, x = r() * (W - 40) - 20, y = r() * (H - 40) - 20;
    out += `<g transform="rotate(${f(r() * 30 - 15)} ${f(x + w / 2)} ${f(y + h / 2)})"><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${col(r, p.slice(0, 4))}" opacity="0.92"/>`;
    if (r() < 0.4) for (let l = 0; l < 8; l++) out += `<rect x="${f(x + 8)}" y="${f(y + 10 + l * 7)}" width="${f(w - 16)}" height="2" fill="#000" opacity="0.25"/>`;
    out += '</g>';
  }
  out += `<circle cx="${f(80 + r() * 140)}" cy="${f(100 + r() * 200)}" r="${f(30 + r() * 30)}" fill="none" stroke="#111" stroke-width="4"/>`;
  out += `<path d="M${f(r() * W)} ${f(r() * H)} Q150 200 ${f(r() * W)} ${f(r() * H)}" stroke="${p[2]}" stroke-width="16" fill="none" stroke-linecap="round" opacity="0.85"/>`;
  return out;
}

const STYLE_GEN = {
  Impressionism: dabs, Expressionism: strokes, Abstract: strokes, Cubism: shards, Surrealism: dreamscape,
  Minimalism: blocks, 'Pop Art': pop, Realism: (r, p, id) => landscape(r, p, id), Futurism: rays, Vaporwave: vapor,
};

function generatorFor(art) {
  switch (art.category) {
    case 'sculpture': return sculpture;
    case 'photography': return art.style === 'Realism' || art.style === 'Minimalism' ? (r, p, id) => landscape(r, p, id, true) : STYLE_GEN[art.style];
    case 'street': return graffiti;
    case 'nft': return pixel;
    case 'ai': return art.style === 'Impressionism' || art.style === 'Vaporwave' ? STYLE_GEN[art.style] : flow;
    case 'mixed': return art.style === 'Cubism' ? shards : collage;
    default: return STYLE_GEN[art.style] || strokes;
  }
}

export function artSVG(art) {
  if (cache.has(art.id)) return cache.get(art.id);
  const r = mulberry32(hashString(art.id + art.title));
  const id = `g${art.id.replace(/[^a-z0-9]/gi, '')}`;
  const body = generatorFor(art)(r, art.palette, id, art);
  const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${esc(art.title)}">${body}</svg>`;
  cache.set(art.id, svg);
  return svg;
}

/** Image markup: uploaded art uses its photo, catalog art uses its generative SVG. */
export function artMarkup(art) {
  if (art.image) return `<img src="${art.image}" alt="${esc(art.title)}" draggable="false">`;
  return artSVG(art);
}
