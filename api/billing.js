// Abremi billing: starts a Stripe Checkout for a plan, or opens the Stripe customer portal to manage
// or cancel. Inactive until payments are switched on (see api/_billing.js). It never grants a plan:
// only the signed webhook (api/stripe-webhook.js) records subscriptions, in the database.
import { billingConfig, formEncode, rpc, PAID_PLANS } from './_billing.js';

const json = (status, body) => ({ status, body });

/** deps: { fetchImpl, env } */
export function createBilling({ fetchImpl, env }) {
  const cfg = billingConfig(env);
  const stripe = async (path, params) => {
    const res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || 'Payment provider error'), { status: 502 });
    return data;
  };

  return async function billing({ method, token, body }) {
    if (method !== 'POST') return json(405, { error: 'Use POST' });
    if (!token) return json(401, { error: 'Sign in first' });
    if (!cfg.enabled || !cfg.supabaseUrl || !cfg.anonKey) return json(503, { error: 'Payments aren’t switched on yet.' });
    const db = { supabaseUrl: cfg.supabaseUrl, key: cfg.anonKey, token };
    try {
      const flags = await rpc(fetchImpl, db, 'app_flags');
      if (!flags?.payments_enabled) return json(503, { error: 'Payments aren’t switched on yet.' });
      const userRes = await fetchImpl(`${cfg.supabaseUrl}/auth/v1/user`, { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}` } });
      if (!userRes.ok) return json(401, { error: 'Sign in again' });
      const user = await userRes.json();

      if (body?.action === 'portal') {
        const rows = await (await fetchImpl(`${cfg.supabaseUrl}/rest/v1/subscriptions?select=billing_customer&user_id=eq.${encodeURIComponent(user.id)}`, {
          headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}` },
        })).json();
        const customer = Array.isArray(rows) ? rows[0]?.billing_customer : null;
        if (!customer) return json(404, { error: 'No paid subscription to manage' });
        const session = await stripe('billing_portal/sessions', { customer, return_url: `${cfg.siteUrl}/#plans` });
        return json(200, { url: session.url });
      }

      const plan = body?.plan;
      if (body?.action !== 'checkout' || !PAID_PLANS.includes(plan) || !cfg.prices[plan]) return json(400, { error: 'Choose a plan' });
      const current = await rpc(fetchImpl, db, 'my_plan');
      if (current?.source === 'billing' && current?.plan?.code !== 'free') return json(409, { error: 'You already have a paid plan: manage it instead' });
      if (plan === 'gallery') {
        const gallery = await rpc(fetchImpl, db, 'my_gallery');
        if (gallery?.status !== 'verified') return json(403, { error: 'The Gallery plan is for verified galleries' });
      }
      const session = await stripe('checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price: cfg.prices[plan], quantity: 1 }],
        client_reference_id: user.id,
        customer_email: user.email,
        subscription_data: { metadata: { user_id: user.id } },
        success_url: `${cfg.siteUrl}/#plans?paid=1`,
        cancel_url: `${cfg.siteUrl}/#plans`,
        allow_promotion_codes: 'true',
        ...(env.STRIPE_AUTOMATIC_TAX === 'true' ? { automatic_tax: { enabled: 'true' }, billing_address_collection: 'required' } : {}),
      });
      return json(200, { url: session.url });
    } catch (e) {
      return json(e.status === 401 ? 401 : 502, { error: e.status === 401 ? 'Sign in again' : 'Payments are unavailable right now. Please try again.' });
    }
  };
}

let billing = null;
/** Vercel entry point. */
export default async function handler(req, res) {
  billing ||= createBilling({ fetchImpl: fetch, env: process.env });
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const { status, body: out } = await billing({ method: req.method, token, body });
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(out);
}
