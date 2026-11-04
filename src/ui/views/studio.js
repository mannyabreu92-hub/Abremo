// Artist Studio: analytics from recorded events only (supabase/migrations/0009_analytics.sql).
// Pure HTML/SVG builders; app.js supplies the data. Charts follow one rule set: one series per
// chart in the brand gold, thin marks, recessive axes, a hover title on every mark, and a table view.

import { esc, fmt, Icon, SectionHeader, EmptyState } from '../components.js';
import { ROLES } from '../../core/scoring.js';
import { countryByCode } from '../../core/seed.js';

// Countries outside the app's list (members can set any ISO code) use the browser's names.
const regionNames = typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
const countryLabel = (code) => countryByCode[code]?.name || (() => { try { return regionNames?.of(code) || code; } catch { return code; } })();
const total = (x) => (typeof x === 'number' ? x : (x?.members || 0) + (x?.guests || 0));
const shortDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "+12%" / "−3%" / "new" against the previous period (never invented when there was nothing before). */
export function change(now, before) {
  if (!before) return now ? { text: 'new', dir: 'up' } : { text: '—', dir: 'flat' };
  const pct = Math.round(((now - before) / before) * 100);
  return { text: `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct)}%`, dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' };
}

function tile(label, now, before, split) {
  const c = change(total(now), total(before));
  return `<div class="stat-tile">
    <small>${esc(label)}</small>
    <b>${fmt(total(now))}</b>
    <span class="delta delta-${c.dir}" title="Compared with the previous period">${esc(c.text)}</span>
    ${split ? `<span class="split">${fmt(now?.members || 0)} members · ${fmt(now?.guests || 0)} guests <abbr title="Guests are counted by an anonymous device key, so their numbers are approximate">(approx.)</abbr></span>` : ''}
  </div>`;
}

/** A single-series bar chart of daily values (SVG), with a hover title per bar and a table view. */
export function barChart(rows, key, label) {
  const max = Math.max(1, ...rows.map((r) => r[key]));
  const w = 640, h = 160, pad = 24, gap = 2;
  const bw = Math.max(2, (w - pad) / rows.length - gap);
  const bars = rows.map((r, i) => {
    const bh = Math.round((r[key] / max) * (h - pad));
    const x = pad + i * (bw + gap);
    return `<g class="bar"><rect x="${x}" y="${h - bh - 0.5}" width="${bw}" height="${Math.max(bh, r[key] ? 2 : 0)}" rx="${Math.min(4, bw / 2)}"><title>${esc(shortDay(r.day))}: ${r[key]} ${esc(label.toLowerCase())}</title></rect>
      <rect class="hit" x="${x - gap / 2}" y="0" width="${bw + gap}" height="${h}"><title>${esc(shortDay(r.day))}: ${r[key]} ${esc(label.toLowerCase())}</title></rect></g>`;
  }).join('');
  return `<figure class="chart">
    <figcaption>${esc(label)} per day</figcaption>
    <svg viewBox="0 0 ${w} ${h + 18}" role="img" aria-label="${esc(label)} per day; peak ${max}">
      <line class="axis" x1="${pad}" x2="${w}" y1="${h}" y2="${h}"/>
      <text class="tick" x="0" y="10">${fmt(max)}</text><text class="tick" x="0" y="${h}">0</text>
      ${bars}
      <text class="tick" x="${pad}" y="${h + 16}">${esc(shortDay(rows[0].day))}</text>
      <text class="tick" x="${w}" y="${h + 16}" text-anchor="end">${esc(shortDay(rows.at(-1).day))}</text>
    </svg>
    ${tableView(rows, key, label)}
  </figure>`;
}

/** A single-series line (follower total over time). */
export function lineChart(rows, key, label) {
  const vals = rows.map((r) => r[key]);
  const max = Math.max(1, ...vals), min = Math.min(...vals, max);
  const w = 640, h = 160, pad = 24;
  const x = (i) => pad + (i * (w - pad)) / Math.max(1, rows.length - 1);
  const y = (v) => h - 4 - ((v - min) / Math.max(1, max - min)) * (h - 20);
  const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[key]).toFixed(1)}`).join(' ');
  const last = rows.length - 1;
  return `<figure class="chart">
    <figcaption>${esc(label)}</figcaption>
    <svg viewBox="0 0 ${w} ${h + 18}" role="img" aria-label="${esc(label)}: ${vals[0]} to ${vals[last]}">
      <line class="axis" x1="${pad}" x2="${w}" y1="${h}" y2="${h}"/>
      <text class="tick" x="0" y="10">${fmt(max)}</text><text class="tick" x="0" y="${h}">${fmt(min)}</text>
      <path class="line" d="${d}"/>
      <circle class="dot" cx="${x(last)}" cy="${y(vals[last])}" r="4"/>
      ${rows.map((r, i) => `<rect class="hit" x="${x(i) - (w - pad) / rows.length / 2}" y="0" width="${(w - pad) / rows.length}" height="${h}"><title>${esc(shortDay(r.day))}: ${r[key]}</title></rect>`).join('')}
      <text class="tick" x="${pad}" y="${h + 16}">${esc(shortDay(rows[0].day))}</text>
      <text class="tick" x="${w}" y="${h + 16}" text-anchor="end">${esc(shortDay(rows[last].day))}</text>
    </svg>
    ${tableView(rows, key, label)}
  </figure>`;
}

function tableView(rows, key, label) {
  return `<details class="table-view"><summary>Show as table</summary>
    <table><thead><tr><th>Day</th><th>${esc(label)}</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${esc(shortDay(r.day))}</td><td>${r[key]}</td></tr>`).join('')}</tbody></table></details>`;
}

/** Horizontal bars for a labelled breakdown (audience by role or country). */
function breakdown(items) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return `<ul class="breakdown">${items.map((i) => `<li><span class="bd-label">${i.label}</span>
    <span class="bd-track"><i style="width:${(i.value / max) * 100}%"></i></span><span class="bd-value">${fmt(i.value)}</span></li>`).join('')}</ul>`;
}

/**
 * The Studio page. s: studio_analytics() result (or null), reports: my_weekly_reports(),
 * ctx: { thumb(id) → HTML, days }.
 */
export function studioPage(s, reports, { thumb = (_id) => '', days = 30, maxDays = 90 } = {}) {
  const periods = [7, 30, 90, 365].map((d) => (d > maxDays
    ? `<a class="seg-locked" href="#plans" title="A year of analytics comes with Artist Pro and Elite">1 year · Pro</a>`
    : `<button role="tab" aria-selected="${d === days}" class="${d === days ? 'is-on' : ''}" data-act="studio-days" data-v="${d}">${d === 365 ? '1 year' : `${d} days`}</button>`)).join('');
  const head = `<header class="page-head page-head-row"><div><p class="eyebrow">Artist Studio</p><h1 class="display-lg">Your audience</h1>
    <p class="muted">Only what was actually recorded: impressions, views and visits once per person per day, plus admirations, treasures and follows. Your own views never count.</p></div></header>
    <div class="seg seg-gold studio-periods" role="tablist">${periods}</div>`;
  if (!s) {
    return `<div class="shell studio">${head}${EmptyState({ icon: 'grid', title: 'Publish a work to open your Studio', body: 'Your analytics start with your first published work.', action: '<a class="btn btn-secondary" href="#profile"><span>Go to Studio</span></a>' })}</div>`;
  }
  const c = s.current, p = s.previous;
  const roles = ROLES.map((r) => ({ label: esc(r.label), value: s.roles?.[r.id] || 0 })).filter((x) => x.value);
  const countries = (s.countries || []).map((x) => ({ label: x.country === 'Other' ? 'Other (fewer than 3 people each)' : `${countryByCode[x.country]?.flag || ''} ${esc(countryLabel(x.country))}`, value: x.people }));
  const works = (s.works || []);
  return `<div class="shell studio">${head}
    <section class="stat-tiles" aria-label="Totals for the last ${s.days} days">
      ${tile('Impressions', c.impressions, p.impressions, true)}
      ${tile('Artwork views', c.views, p.views, true)}
      ${tile('Profile visits', c.visits, p.visits, true)}
      ${tile('Admirations', c.likes, p.likes)}
      ${tile('Saves', c.saves, p.saves)}
      ${tile('New followers', c.followers, p.followers)}
    </section>
    <p class="fine">Changes compare with the ${s.days} days before. Followers today: <b>${fmt(s.followers_total)}</b>.</p>
    <section class="section section-tight chart-grid">
      ${barChart(s.daily, 'views', 'Artwork views')}
      ${barChart(s.daily, 'likes', 'Admirations and treasures')}
      ${lineChart(s.daily, 'followers', 'Followers')}
    </section>
    <section class="section section-tight">${SectionHeader({ eyebrow: 'Per work', title: 'Your works' })}
      ${works.length ? `<div class="table-wrap"><table class="works-table"><thead><tr><th>Work</th><th>Impressions</th><th>Views</th><th>Admirations</th><th>Treasures</th><th title="Admirations and treasures per view">Admired by viewers</th><th title="Conversations started about this work">Inquiries</th><th title="Verified collectors who saved it">Collector treasures</th></tr></thead>
        <tbody>${works.map((w) => `<tr><td><button class="link work-link" data-act="artwork" data-id="${esc(w.id)}">${thumb(w.id)}<span>${esc(w.title)}</span></button></td>
          <td>${fmt(w.impressions)}</td><td>${fmt(w.views)}</td><td>${fmt(w.likes)}</td><td>${fmt(w.saves)}</td>
          <td>${w.views ? `${Math.min(100, Math.round(((w.likes + w.saves) / w.views) * 100))}%` : '—'}</td>
          <td>${w.inquiries == null ? '—' : fmt(w.inquiries)}</td><td>${w.collector_saves == null ? '—' : fmt(w.collector_saves)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No works yet.</p>'}
    </section>
    <section class="section section-tight audience">
      <div>${SectionHeader({ eyebrow: 'Audience', title: 'Who engages, by role' })}
        ${roles.length ? breakdown(roles) : '<p class="muted">Nobody has liked, saved or followed yet in this period.</p>'}</div>
      <div>${SectionHeader({ eyebrow: 'Audience', title: 'Where members are' })}
        ${countries.length ? breakdown(countries) : '<p class="muted">No member activity yet in this period.</p>'}
        <p class="fine">From members’ profile countries (no location tracking). Guests aren’t included.</p></div>
    </section>
    <section class="section section-tight">${SectionHeader({ eyebrow: 'Every Monday', title: 'Weekly reports' })}
      ${reports?.length ? `<ol class="report-list">${reports.map((r) => reportRow(r)).join('')}</ol>` : '<p class="muted">Your first report arrives the Monday after your first week on Abremi.</p>'}
    </section>
  </div>`;
}

function reportRow(r) {
  const c = r.current, p = r.previous;
  const item = (label, a, b) => { const ch = change(total(a), total(b)); return `<span><small>${label}</small> <b>${fmt(total(a))}</b> <em class="delta delta-${ch.dir}">${esc(ch.text)}</em></span>`; };
  return `<li class="report"><p class="eyebrow">${Icon('clock', { size: 14 })} Week of ${esc(shortDay(r.week_start))}</p>
    <div class="report-items">${item('Views', c.views, p.views)}${item('Visits', c.visits, p.visits)}${item('Admirations', c.likes, p.likes)}${item('Treasures', c.saves, p.saves)}${item('New followers', c.followers, p.followers)}</div></li>`;
}
