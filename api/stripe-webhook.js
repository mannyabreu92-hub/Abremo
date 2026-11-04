// Stripe webhook: the only place a paid plan is recorded. Checks Stripe's signature, maps the price to
// a plan (never trusting metadata for the plan), and calls apply_billing_event() with the service
// role. The database applies each event once and refuses everything while payments are off.
import { billingConfig, rawBody, rpc, verifyStripeSignature } from './_billing.js';

const STATUS = { active: 'active', trialing: 'trialing', past_due: 'past_due', canceled: 'canceled', unpaid: 'canceled', incomplete_expired: 'canceled' };
const HANDLED = ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'];

/**
 * @param {{ fetchImpl: typeof fetch, env: Record<string, string | undefined>, now?: () => number }} deps
 * @returns {(payload: string, signature: string | undefined) => Promise<{ status: number, body: object }>}
 */
export function createWebhook({ fetchImpl, env, now }) {
  const cfg = billingConfig(env);
  return async function webhook(payload, signature) {
    if (!cfg.enabled || !cfg.webhookSecret || !cfg.serviceKey || !cfg.supabaseUrl) return { status: 503, body: { error: 'Payments aren’t switched on' } };
    if (!verifyStripeSignature(payload, signature, cfg.webhookSecret, now?.())) return { status: 400, body: { error: 'Bad signature' } };
    let event;
    try { event = JSON.parse(payload); } catch { return { status: 400, body: { error: 'Bad payload' } }; }
    if (!HANDLED.includes(event?.type)) return { status: 200, body: { result: 'ignored' } };
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
