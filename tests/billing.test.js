// Billing server functions (inactive until payments are switched on), with stand-ins for Stripe and
// the database. No real keys or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyStripeSignature, formEncode, billingConfig } from '../api/_billing.js';
import { createBilling } from '../api/billing.js';
import { createWebhook } from '../api/stripe-webhook.js';

const ENV = {
  BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x',
  STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_ELITE: 'price_elite', STRIPE_PRICE_GALLERY: 'price_gallery',
  SUPABASE_URL: 'https://db.example.co', SUPABASE_ANON_KEY: 'pk', SUPABASE_SERVICE_ROLE_KEY: 'service', SITE_URL: 'https://abremi.example',
};
const sign = (payload, t, secret = 'whsec_x') => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;

function stand({ payments = true, plan = { source: null, plan: { code: 'free' } }, gallery = null, rpcResult = 'applied' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/rpc/app_flags')) return Response.json({ payments_enabled: payments, invite_required: false });
    if (url.endsWith('/rpc/my_plan')) return Response.json(plan);
    if (url.endsWith('/rpc/my_gallery')) return Response.json(gallery);
    if (url.endsWith('/rpc/apply_billing_event')) return Response.json(rpcResult);
    if (url.endsWith('/auth/v1/user')) return init.headers.Authorization === 'Bearer good' ? Response.json({ id: 'u-1', email: 'ana@example.com' }) : new Response('{}', { status: 401 });
    if (url.includes('/rest/v1/subscriptions')) return Response.json([{ billing_customer: 'cus_9' }]);
    if (url.startsWith('https://api.stripe.com/v1/')) return Response.json({ url: `https://checkout.stripe.example/${url.split('/v1/')[1]}` });
    return new Response('not found', { status: 404 });
  };
  return { calls, fetchImpl };
}

test('Stripe signatures: valid, wrong secret, tampered, stale and malformed', () => {
  const body = '{"id":"evt_1"}';
  assert.equal(verifyStripeSignature(body, sign(body, 1000), 'whsec_x', 1100), true);
  assert.equal(verifyStripeSignature(body, sign(body, 1000, 'other'), 'whsec_x', 1100), false);
  assert.equal(verifyStripeSignature(`${body} `, sign(body, 1000), 'whsec_x', 1100), false);
  assert.equal(verifyStripeSignature(body, sign(body, 1000), 'whsec_x', 2000), false, 'older than 5 minutes');
  assert.equal(verifyStripeSignature(body, 'nonsense', 'whsec_x', 1000), false);
  assert.equal(verifyStripeSignature(body, undefined, 'whsec_x', 1000), false);
  assert.equal(verifyStripeSignature(body, sign(body, 1000), '', 1000), false, 'no secret, no trust');
});

test('form encoding matches Stripe’s nested format', () => {
  assert.equal(formEncode({ mode: 'subscription', line_items: [{ price: 'p 1', quantity: 1 }], x: null, m: { user_id: 'u' } }),
    'mode=subscription&line_items%5B0%5D%5Bprice%5D=p%201&line_items%5B0%5D%5Bquantity%5D=1&m%5Buser_id%5D=u');
});

test('billing is off unless switched on in Vercel AND in the database', async () => {
  for (const env of [{}, { ...ENV, BILLING_ENABLED: 'false' }, { ...ENV, STRIPE_SECRET_KEY: '' }]) {
    const { fetchImpl, calls } = stand();
    const out = await createBilling({ fetchImpl, env })({ method: 'POST', token: 'good', body: { action: 'checkout', plan: 'pro' } });
    assert.equal(out.status, 503);
    assert.equal(calls.length, 0, 'nothing is called');
  }
  const { fetchImpl, calls } = stand({ payments: false });
  const out = await createBilling({ fetchImpl, env: ENV })({ method: 'POST', token: 'good', body: { action: 'checkout', plan: 'pro' } });
  assert.equal(out.status, 503);
  assert.equal(calls.some((c) => c.url.includes('stripe.com')), false);
});

test('checkout: signed-in members only; the plan maps to the configured price; galleries must be verified', async () => {
  let { fetchImpl, calls } = stand();
  const billing = createBilling({ fetchImpl, env: ENV });
  assert.equal((await billing({ method: 'GET', token: 'good', body: {} })).status, 405);
  assert.equal((await billing({ method: 'POST', token: null, body: {} })).status, 401);
  assert.equal((await billing({ method: 'POST', token: 'bad', body: { action: 'checkout', plan: 'pro' } })).status, 401);
  assert.equal((await billing({ method: 'POST', token: 'good', body: { action: 'checkout', plan: 'free' } })).status, 400);
  const ok = await billing({ method: 'POST', token: 'good', body: { action: 'checkout', plan: 'elite' } });
  assert.equal(ok.status, 200);
  const req = calls.find((c) => c.url.endsWith('/checkout/sessions'));
  assert.equal(req.init.headers.Authorization, 'Bearer sk_test_x');
  const form = new URLSearchParams(req.init.body);
  assert.equal(form.get('line_items[0][price]'), 'price_elite');
  assert.equal(form.get('mode'), 'subscription');
  assert.equal(form.get('subscription_data[metadata][user_id]'), 'u-1', 'the user comes from the verified session, not the request');
  assert.equal(form.get('success_url'), 'https://abremi.example/#plans?paid=1');
  ({ fetchImpl } = stand({ gallery: { status: 'pending' } }));
  assert.equal((await createBilling({ fetchImpl, env: ENV })({ method: 'POST', token: 'good', body: { action: 'checkout', plan: 'gallery' } })).status, 403);
  ({ fetchImpl } = stand({ plan: { source: 'billing', plan: { code: 'pro' } } }));
  assert.equal((await createBilling({ fetchImpl, env: ENV })({ method: 'POST', token: 'good', body: { action: 'checkout', plan: 'elite' } })).status, 409);
  ({ fetchImpl, calls } = stand());
  const portal = await createBilling({ fetchImpl, env: ENV })({ method: 'POST', token: 'good', body: { action: 'portal' } });
  assert.equal(portal.status, 200);
  assert.equal(new URLSearchParams(calls.find((c) => c.url.endsWith('/billing_portal/sessions')).init.body).get('customer'), 'cus_9');
});

test('webhook: only signed subscription events, the plan from the price (never metadata), recorded with the service role', async () => {
  const now = () => 5000;
  const event = (type, sub) => JSON.stringify({ id: 'evt_7', type, data: { object: sub } });
  const sub = { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { user_id: 'u-1', plan: 'elite' },
    items: { data: [{ price: { id: 'price_pro' }, current_period_end: 6000 }] } };
  let { fetchImpl, calls } = stand();
  const hook = createWebhook({ fetchImpl, env: ENV, now });
  const body = event('customer.subscription.updated', sub);
  assert.equal((await hook(body, sign(body, 4999, 'wrong'))).status, 400);
  const ok = await hook(body, sign(body, 4999));
  assert.deepEqual(ok, { status: 200, body: { result: 'applied' } });
  const rpc = calls.find((c) => c.url.endsWith('/rpc/apply_billing_event'));
  assert.equal(rpc.init.headers.apikey, 'service');
  assert.equal(rpc.init.headers.Authorization, undefined, 'a server key never goes in Authorization');
  const args = JSON.parse(rpc.init.body);
  assert.equal(args.p_plan, 'pro', 'from the price, not metadata.plan');
  assert.equal(args.p_status, 'active');
  assert.equal(args.p_period_end, new Date(6000 * 1000).toISOString());
  const del = event('customer.subscription.deleted', { ...sub, status: 'active' });
  await hook(del, sign(del, 4999));
  assert.equal(JSON.parse(calls.filter((c) => c.url.endsWith('/rpc/apply_billing_event')).at(-1).init.body).p_status, 'canceled');
  const other = event('invoice.paid', {});
  assert.equal((await hook(other, sign(other, 4999))).body.result, 'ignored');
  const unknown = event('customer.subscription.updated', { ...sub, items: { data: [{ price: { id: 'price_someone_else' } }] } });
  assert.equal((await hook(unknown, sign(unknown, 4999))).body.result, 'not an Abremi plan');
  ({ fetchImpl, calls } = stand());
  const off = createWebhook({ fetchImpl, env: { ...ENV, BILLING_ENABLED: 'false' }, now });
  assert.equal((await off(body, sign(body, 4999))).status, 503);
  assert.equal(calls.length, 0);
  assert.equal(billingConfig(ENV).planForPrice(''), null);
});
