// Abremi checkout (Stripe Connect Express). Inactive until SALES_ENABLED=true in Vercel AND
// app_settings.sales_enabled in the database. Abremi never holds artists' money: buyers pay through
// Stripe Checkout, Stripe sends the artist's share to their own Stripe account, and Abremi keeps a
// 20% application fee. Orders are created by the database (begin_purchase), as the buyer.
//
// POST { action: 'buy', artworkId }      → { url }  Stripe Checkout
// POST { action: 'onboard', country? }   → { url }  Stripe's payout setup for the artist
// POST { action: 'dashboard' }           → { url }  the artist's Stripe Express dashboard
import { billingConfig, formEncode, rpc } from './_billing.js';

// Where artists can ship to at launch (a common set; extend as needed).
export const SHIP_TO = ['US', 'CA', 'MX', 'PR', 'DO', 'JM', 'TT', 'BS', 'BB', 'GB', 'IE', 'FR', 'DE', 'ES', 'PT', 'IT', 'NL', 'BE', 'AT', 'CH',
  'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'GR', 'AU', 'NZ', 'JP', 'KR', 'SG', 'HK', 'BR', 'AR', 'CL', 'CO', 'PE', 'ZA', 'AE'];

const json = (status, body) => ({ status, body });

/** deps: { fetchImpl, env } */
export function createCheckout({ fetchImpl, env }) {
  const cfg = billingConfig(env);
  const stripe = async (path, params) => {
    const res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error('Payment provider error'), { status: 502 });
    return data;
  };
  const service = (name, args) => rpc(fetchImpl, { supabaseUrl: cfg.supabaseUrl, key: cfg.serviceKey }, name, args);

  return async function checkout({ method, token, body }) {
    if (method !== 'POST') return json(405, { error: 'Use POST' });
    if (!token) return json(401, { error: 'Sign in first' });
    if (!cfg.salesEnabled || !cfg.supabaseUrl || !cfg.anonKey || !cfg.serviceKey) return json(503, { error: 'Buying isn’t switched on yet.' });
    const asMember = { supabaseUrl: cfg.supabaseUrl, key: cfg.anonKey, token };
    try {
      const flags = await rpc(fetchImpl, asMember, 'app_flags');
      if (!flags?.sales_enabled) return json(503, { error: 'Buying isn’t switched on yet.' });

      if (body?.action === 'buy') {
        let order;
        try {
          order = await rpc(fetchImpl, asMember, 'begin_purchase', { p_artwork: String(body.artworkId || '') });
        } catch (e) {
          return json(e.status === 401 ? 401 : 400, { error: e.message });
        }
        const target = await service('order_payout_target', { p_order: order.order_id });
        if (!target) return json(400, { error: 'This artist can’t take payments yet.' });
        const session = await stripe('checkout/sessions', {
          mode: 'payment',
          client_reference_id: order.order_id,
          metadata: { order_id: order.order_id },
          line_items: [{ quantity: 1, price_data: { currency: order.currency, unit_amount: order.amount_cents, product_data: { name: order.title } } }],
          payment_intent_data: { application_fee_amount: order.fee_cents, transfer_data: { destination: target }, metadata: { order_id: order.order_id } },
          shipping_address_collection: { allowed_countries: SHIP_TO },
          success_url: `${cfg.siteUrl}/#orders?paid=1`,
          cancel_url: `${cfg.siteUrl}/#art/${encodeURIComponent(String(body.artworkId))}`,
        });
        await service('attach_checkout_session', { p_order: order.order_id, p_session: session.id });
        return json(200, { url: session.url });
      }

      const userRes = await fetchImpl(`${cfg.supabaseUrl}/auth/v1/user`, { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}` } });
      if (!userRes.ok) return json(401, { error: 'Sign in again' });
      const user = await userRes.json();
      let account = await service('payout_account_for', { p_user: user.id });

      if (body?.action === 'onboard') {
        if (!account) {
          const country = /^[A-Z]{2}$/.test(body.country || '') ? body.country : 'US';
          const created = await stripe('accounts', {
            type: 'express', country, email: user.email,
            capabilities: { card_payments: { requested: 'true' }, transfers: { requested: 'true' } },
            metadata: { user_id: user.id },
          });
          account = created.id;
          await service('set_payout_account', { p_user: user.id, p_account: account, p_charges: false, p_payouts: false, p_details: false });
        }
        const link = await stripe('account_links', {
          account, type: 'account_onboarding',
          refresh_url: `${cfg.siteUrl}/#orders?payouts=retry`, return_url: `${cfg.siteUrl}/#orders?payouts=done`,
        });
        return json(200, { url: link.url });
      }
      if (body?.action === 'dashboard') {
        if (!account) return json(404, { error: 'Set up payouts first' });
        const link = await stripe(`accounts/${encodeURIComponent(account)}/login_links`, {});
        return json(200, { url: link.url });
      }
      return json(400, { error: 'Unknown action' });
    } catch {
      return json(502, { error: 'Payments are unavailable right now. Please try again.' });
    }
  };
}

let checkout = null;
/** Vercel entry point. */
export default async function handler(req, res) {
  checkout ||= createCheckout({ fetchImpl: fetch, env: process.env });
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const { status, body: out } = await checkout({ method: req.method, token, body });
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(out);
}
