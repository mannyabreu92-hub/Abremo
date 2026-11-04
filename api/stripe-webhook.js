// Stripe webhook: the only place a paid plan is recorded. Checks Stripe's signature, maps the price to
// a plan (never trusting metadata for the plan), and calls apply_billing_event() with the service
// role. The database applies each event once and refuses everything while payments are off.
import { billingConfig, rawBody, rpc, verifyStripeSignature } from './_billing.js';

const STATUS = { active: 'active', trialing: 'trialing', past_due: 'past_due', canceled: 'canceled', unpaid: 'canceled', incomplete_expired: 'canceled' };
const HANDLED = ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'];
const SALES = ['checkout.session.completed', 'charge.refunded', 'account.updated'];

/**
 * @param {{ fetchImpl: typeof fetch, env: Record<string, string | undefined>, now?: () => number }} deps
 * @returns {(payload: string, signature: string | undefined) => Promise<{ status: number, body: object }>}
 */
export function createWebhook({ fetchImpl, env, now }) {
  const cfg = billingConfig(env);
  const service = (name, args) => rpc(fetchImpl, { supabaseUrl: cfg.supabaseUrl, key: cfg.serviceKey }, name, args);
  /** Artwork sales: a paid Checkout, a refund, or an artist's payout account changing. */
  async function sale(event) {
    const o = event.data?.object || {};
    try {
      if (event.type === 'checkout.session.completed') {
        if (o.mode !== 'payment' || !o.metadata?.order_id) return { status: 200, body: { result: 'ignored' } };
        if (o.payment_status !== 'paid') return { status: 200, body: { result: 'not paid yet' } };
        const ship = o.collected_information?.shipping_details || o.shipping_details || null;
        const result = await service('complete_order', {
          p_session: o.id, p_payment_intent: typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id || null,
          p_amount: o.amount_total, p_shipping: ship ? { name: ship.name || null, address: ship.address || null } : null,
        });
        return { status: 200, body: { result } };
      }
      if (event.type === 'charge.refunded') {
        const pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id;
        if (!pi || !o.refunded) return { status: 200, body: { result: 'partial or unknown refund' } };
        return { status: 200, body: { result: await service('refund_order', { p_payment_intent: pi }) } };
      }
      await service('update_payout_status', { p_account: o.id, p_charges: Boolean(o.charges_enabled), p_payouts: Boolean(o.payouts_enabled), p_details: Boolean(o.details_submitted) });
      return { status: 200, body: { result: 'updated' } };
    } catch {
      return { status: 500, body: { error: 'Could not record the event' } }; // Stripe retries
    }
  }

  return async function webhook(payload, signature) {
    if (!(cfg.enabled || cfg.salesEnabled) || !cfg.webhookSecret || !cfg.serviceKey || !cfg.supabaseUrl) return { status: 503, body: { error: 'Payments aren’t switched on' } };
    const signed = [cfg.webhookSecret, cfg.connectWebhookSecret].some((secret) => secret && verifyStripeSignature(payload, signature, secret, now?.()));
    if (!signed) return { status: 400, body: { error: 'Bad signature' } };
    let event;
    try { event = JSON.parse(payload); } catch { return { status: 400, body: { error: 'Bad payload' } }; }
    if (SALES.includes(event?.type)) return cfg.salesEnabled ? sale(event) : { status: 503, body: { error: 'Sales aren’t switched on' } };
    if (!HANDLED.includes(event?.type) || !cfg.enabled) return { status: 200, body: { result: 'ignored' } };
    const sub = event.data?.object || {};
    const status = event.type === 'customer.subscription.deleted' ? 'canceled' : STATUS[sub.status];
    if (!status) return { status: 200, body: { result: 'ignored' } }; // e.g. incomplete: wait for the next event
    const item = sub.items?.data?.[0];
    const plan = cfg.planForPrice(item?.price?.id);
    const user = sub.metadata?.user_id;
    if (!plan || !user) return { status: 200, body: { result: 'not an Abremi plan' } };
    const periodEnd = sub.current_period_end ?? item?.current_period_end;
    try {
      const result = await rpc(fetchImpl, { supabaseUrl: cfg.supabaseUrl, key: cfg.serviceKey }, 'apply_billing_event', {
        p_event_id: event.id, p_kind: event.type, p_user: user, p_plan: plan, p_status: status,
        p_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
        p_customer: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null, p_subscription: sub.id || null,
      });
      return { status: 200, body: { result } };
    } catch {
      return { status: 500, body: { error: 'Could not record the event' } }; // Stripe retries
    }
  };
}

let webhook = null;
/** Vercel entry point. */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  webhook ||= createWebhook({ fetchImpl: fetch, env: process.env });
  const { status, body } = await webhook(await rawBody(req), req.headers['stripe-signature']);
  res.status(status).json(body);
}
