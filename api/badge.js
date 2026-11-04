// The Abremi Index badge: a small image artists can put on their own website.
//   <a href="https://abremi.vercel.app/#artist/ID"><img src="https://abremi.vercel.app/api/badge?artist=ID" alt="Abremi Index"></a>
// It shows the artist's best place in the latest weekly Index (migration 0016), read with the public
// key only. Artists who aren't ranked this week get a plain "On Abremi" badge, so embeds never break.
import { CATEGORIES, countryByCode } from '../src/core/seed.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MEDIUM = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));

/** "Oil Painting", "Portugal" or "Overall" for a chart key. */
export function chartLabel(chart) {
  if (chart === 'overall') return 'Overall';
  if (chart?.startsWith('medium:')) return MEDIUM[chart.slice(7)] || chart.slice(7);
  if (chart?.startsWith('country:')) return countryByCode[chart.slice(8)]?.name || chart.slice(8);
  return 'Overall';
}

/** The badge image (SVG). b: the artist_index_badge() row, or null. */
export function badgeSVG(b) {
  const week = b ? new Date(`${b.covers_from}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
  const main = b ? `#${b.rank} · ${chartLabel(b.chart)}` : 'On Abremi';
  const sub = b ? `Week of ${week}` : 'Discover art. Shape culture.';
  const w = Math.max(220, 34 + Math.round(main.length * 9.4));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="58" viewBox="0 0 ${w} 58" role="img" aria-label="${esc(b ? `Abremi Index: ${main}, ${sub}` : 'On Abremi')}">
<rect x="0.5" y="0.5" width="${w - 1}" height="57" rx="10" fill="#0b0c0d" stroke="#d6ad68" stroke-opacity=".55"/>
<path d="M16 41 L22.5 17 L29 41 M18.6 33 H26.4" fill="none" stroke="#d6ad68" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
<text x="38" y="22" fill="#d6ad68" font-family="Inter, Helvetica, Arial, sans-serif" font-size="9.5" letter-spacing="1.6">ABREMI INDEX</text>
<text x="38" y="39" fill="#f3efe7" font-family="Georgia, 'Times New Roman', serif" font-size="15">${esc(main)}</text>
<text x="38" y="51" fill="#9a958c" font-family="Inter, Helvetica, Arial, sans-serif" font-size="9">${esc(sub)}</text>
</svg>`;
}

/** deps: { fetchImpl, supabaseUrl, supabaseKey } → (artistId) => { status, body } */
export function createBadge({ fetchImpl, supabaseUrl, supabaseKey }) {
  return async function badge(artistId) {
    if (!/^[A-Za-z0-9_@.-]{1,80}$/.test(artistId || '')) return { status: 400, body: badgeSVG(null) };
    if (!supabaseUrl || !supabaseKey) return { status: 200, body: badgeSVG(null) };
    try {
      const res = await fetchImpl(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/artist_index_badge`, {
        method: 'POST',
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_artist: artistId }),
      });
      const text = await res.text();
      const b = res.ok && text ? JSON.parse(text) : null;
      return { status: 200, body: badgeSVG(b && b.rank ? b : null) };
    } catch {
      return { status: 200, body: badgeSVG(null) };
    }
  };
}

let badge = null;
/** Vercel entry point: GET /api/badge?artist=ID */
export default async function handler(req, res) {
  badge ||= createBadge({
    fetchImpl: fetch,
    supabaseUrl: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  const artist = new URL(req.url, 'https://abremi.vercel.app').searchParams.get('artist');
  const { status, body } = await badge(artist);
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.status(status).send(body);
}
