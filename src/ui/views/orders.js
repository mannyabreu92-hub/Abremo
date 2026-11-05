// Orders (#orders): the artist's payouts and sales, and the collector's purchases.
// Pure HTML builders; every action is checked again by the database (migration 0017).

import { esc, Icon, PremiumButton, EmptyState, SectionHeader, t } from '../components.js';
import { locale, formatDate } from '../i18n.js';

const amount = (o) => `${(o.currency || 'usd').toUpperCase()} ${(o.amount_cents / 100).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => (d ? formatDate(d) : '');
const STATUS = { paid: 'Paid · to ship', shipped: 'Shipped', delivered: 'Delivered', disputed: 'Problem reported', refunded: 'Refunded' };

/** @param {{ sales: any[], purchases: any[] }} d */
export function ordersPage(d, { payout, isArtist, salesOn, busy = '', country = 'US' }) {
  return `<div class="shell orders-page">
    <header class="page-head"><p class="eyebrow">${t('Buying and selling')}</p><h1 class="display-lg">${t('Orders')}</h1>
      <p class="muted">${t('Payments go through Stripe. Abremi keeps a 20% commission on each sale; the rest goes straight to the artist’s own Stripe account.')}</p></header>
    ${isArtist ? payoutCard(payout, { salesOn, busy, country }) : ''}
    ${isArtist ? `<section class="section section-tight">${SectionHeader({ eyebrow: 'As an artist', title: 'Sales' })}
      ${d.sales.length ? d.sales.map(saleCard).join('') : `<p class="muted">${t('No sales yet.')}</p>`}</section>` : ''}
    <section class="section section-tight">${SectionHeader({ eyebrow: 'As a collector', title: 'Purchases' })}
      ${d.purchases.length ? d.purchases.map(purchaseCard).join('') : EmptyState({ icon: 'bookmark', title: 'No purchases yet', body: 'Works you buy on Abremi appear here, with shipping and tracking.' })}</section>
    <p class="fine">${t('Returns: if a work arrives damaged or not as described, report a problem within 14 days of delivery and a moderator will decide.')}</p>
  </div>`;
}

function payoutCard(p, { salesOn, busy, country }) {
  if (!salesOn) return `<p class="notice">${Icon('info', { size: 16 })} ${t('Selling through Abremi isn’t switched on yet. Collectors can still make offers and ask about your works.')}</p>`;
  const ready = p?.charges_enabled;
  return `<section class="section section-tight payout-card">${SectionHeader({ eyebrow: 'Getting paid', title: ready ? 'Payouts are ready' : 'Set up payouts' })}
    ${ready ? `<p class="muted">${t('Collectors can buy your works with a listed price. Stripe pays you directly.')}</p>
        ${PremiumButton(busy === 'payouts' ? 'Opening…' : 'Open your Stripe dashboard', { act: 'payouts-setup', variant: 'secondary', attrs: `data-v="dashboard"${busy ? ' disabled' : ''}` })}`
      : `<p class="muted">${p?.connected ? t('Finish your details with Stripe to start selling.') : t('Stripe verifies your identity and bank details, then pays you directly. Abremi never holds your money.')}</p>
        ${p?.connected ? '' : `<label class="field"><span>${t('Country where you’ll be paid')}</span><input id="payout-country" maxlength="2" value="${esc(country)}" autocapitalize="characters"></label>`}
        ${PremiumButton(busy === 'payouts' ? 'Opening Stripe…' : p?.connected ? 'Finish setup with Stripe' : 'Set up payouts with Stripe', { act: 'payouts-setup', attrs: busy ? 'disabled' : '' })}`}
  </section>`;
}

function saleCard(o) {
  const ship = o.shipping?.address ? [o.shipping.name, o.shipping.address.line1, o.shipping.address.line2, [o.shipping.address.postal_code, o.shipping.address.city].filter(Boolean).join(' '), o.shipping.address.state, o.shipping.address.country].filter(Boolean).join(', ') : '';
  return `<article class="order-card">
    <p class="eyebrow">${esc(t(STATUS[o.status] || o.status))} · ${esc(day(o.paid_at))}</p>
    <h3>${esc(o.title)}${o.edition_number ? ` <small class="muted">${t('print {n}', { n: o.edition_number })}</small>` : ''}</h3>
    <p class="muted">${esc(amount(o))} · ${t('Abremi commission')} ${esc(amount({ ...o, amount_cents: o.fee_cents }))} · ${t('buyer')} ${esc(o.buyer || '')}</p>
    ${ship ? `<p><b>${t('Ship to:')}</b> ${esc(ship)}</p>` : ''}
    ${o.tracking ? `<p class="muted">${esc(o.carrier)} ${esc(o.tracking)}</p>` : ''}
    ${o.dispute_reason ? `<p class="notice">${Icon('info', { size: 16 })} ${t('Problem reported:')} ${esc(o.dispute_reason)}${o.dispute_resolution ? ` · ${t('Decision:')} ${esc(o.dispute_resolution)}` : ''}</p>` : ''}
    ${o.certificate ? `<p><a class="link-arrow" href="#certificate/${esc(o.certificate)}">${Icon('check', { size: 14 })} ${t('Certificate of authenticity')} · ${esc(o.certificate)}</a></p>` : ''}
    ${o.status === 'paid' ? `<div class="field-row"><label class="field"><span>${t('Carrier')}</span><input id="ship-carrier-${esc(o.id)}" maxlength="60" placeholder="UPS, DHL, USPS…"></label>
        <label class="field"><span>${t('Tracking number')}</span><input id="ship-tracking-${esc(o.id)}" maxlength="100"></label></div>
        ${PremiumButton('Mark as shipped', { act: 'order-ship', attrs: `data-id="${esc(o.id)}"` })}` : ''}
  </article>`;
}

function purchaseCard(o) {
  return `<article class="order-card">
    <p class="eyebrow">${esc(t(STATUS[o.status] || o.status))} · ${esc(day(o.paid_at))}</p>
    <h3>${o.artwork_id ? `<button class="link" data-act="artwork" data-id="${esc(o.artwork_id)}">${esc(o.title)}</button>` : esc(o.title)}${o.edition_number ? ` <small class="muted">${t('print {n}', { n: o.edition_number })}</small>` : ''}</h3>
    <p class="muted">${esc(amount(o))}${o.artist ? ` · ${t('by {name}', { name: esc(o.artist) })}` : ''}</p>
    ${o.tracking ? `<p>${Icon('arrow', { size: 14 })} ${esc(o.carrier)} ${esc(o.tracking)}</p>` : o.status === 'paid' ? `<p class="muted">${t('The artist will ship it and add tracking here.')}</p>` : ''}
    ${o.dispute_resolution ? `<p class="muted">${t('Decision:')} ${esc(o.dispute_resolution)}</p>` : ''}
    ${o.certificate ? `<p><a class="link-arrow" href="#certificate/${esc(o.certificate)}">${Icon('check', { size: 14 })} ${t('Certificate of authenticity')}</a></p>` : ''}
    <div class="detail-actions">
      ${o.status === 'shipped' ? PremiumButton('I received it', { act: 'order-delivered', attrs: `data-id="${esc(o.id)}"` }) : ''}
      ${o.can_dispute ? PremiumButton('Report a problem', { act: 'order-dispute', variant: 'ghost', attrs: `data-id="${esc(o.id)}"` }) : ''}
    </div>
  </article>`;
}
