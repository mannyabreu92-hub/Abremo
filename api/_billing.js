// Shared billing code for api/billing.js and api/stripe-webhook.js (files starting with "_" are not
// deployed as functions). Payments are OFF until all of these are true:
//   * BILLING_ENABLED=true in Vercel, with STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//     STRIPE_PRICE_PRO, STRIPE_PRICE_ELITE, STRIPE_PRICE_GALLERY and SUPABASE_SERVICE_ROLE_KEY set;
//   * app_settings.payments_enabled = true in the database (set in the SQL editor, after review).
// The service role key is used only by the webhook, on the server, to record subscriptions.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PAID_PLANS = ['pro', 'elite', 'gallery'];

/** @param {Record<string, string | undefined>} env */
export function billingConfig(env) {
  const prices = { pro: env.STRIPE_PRICE_PRO, elite: env.STRIPE_PRICE_ELITE, gallery: env.STRIPE_PRICE_GALLERY };
  return {
    enabled: env.BILLING_ENABLED === 'true' && Boolean(env.STRIPE_SECRET_KEY),
    // Artwork sales (Stripe Connect), switched on separately from subscriptions.
    salesEnabled: env.SALES_ENABLED === 'true' && Boolean(env.STRIPE_SECRET_KEY),
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    // Stripe signs events from connected accounts (account.updated) with a separate Connect endpoint secret.
    connectWebhookSecret: env.STRIPE_CONNECT_WEBHOOK_SECRET || '',
    prices,
    /** @param {string} priceId */
    planForPrice: (priceId) => /** @type {string | null} */ (Object.entries(prices).find(([, id]) => id && id === priceId)?.[0] || null),
    siteUrl: (env.SITE_URL || 'https://abremi.app').replace(/\/+$/, ''),
    supabaseUrl: (env.SUPABASE_URL || '').replace(/\/+$/, ''),
    anonKey: env.SUPABASE_ANON_KEY || '',
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
  };
}

/**
 * Checks a Stripe webhook signature (header "t=…,v1=…"): HMAC-SHA256 of "t.payload" with the
 * endpoint secret, and a timestamp within the tolerance.
 * @param {string} payload raw request body
 * @param {string | undefined} header
 * @param {string} secret
 * @param {number} [now] seconds
 */
export function verifyStripeSignature(payload, header, secret, now = Math.floor(Date.now() / 1000), tolerance = 300) {
  if (!secret || !header) return false;
  const parts = header.split(',').map((p) => p.split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(now - t) > tolerance) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex'));
  return sigs.some((s) => {
    const got = Buffer.from(String(s));
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/** Form-encodes nested params the way Stripe's API expects (a[b][0]=c). */
export function formEncode(obj, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') out.push(formEncode(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join('&');
}

/**
 * Calls a database function; errors carry the HTTP status.
 * @param {typeof fetch} fetchImpl
 * @param {{ supabaseUrl: string, key: string, token?: string | null }} db the user's token, or none to act as the key's role
 * @param {string} name
 * @param {object} [args]
 */
export async function rpc(fetchImpl, { supabaseUrl, key, token = null }, name, args = {}) {
  const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${token || key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(data?.message || `Request failed (${res.status})`), { status: res.status });
  return data;
}

/** Reads a Node request body as text (the webhook needs the exact bytes for the signature). */
export async function rawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf8');
}
