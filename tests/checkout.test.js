// Artwork checkout (Stripe Connect) and the sales webhook, with stand-ins for Stripe and the database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createCheckout, SHIP_TO } from '../api/checkout.js';
import { createWebhook } from '../api/stripe-webhook.js';

const ENV = { SALES_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', SUPABASE_URL: 'https://db.example.co',
  SUPABASE_ANON_KEY: 'pk', SUPABASE_SERVICE_ROLE_KEY: 'service', SITE_URL: 'https://abremi.example' };
const sign = (payload, t) => `t=${t},v1=${createHmac('sha256', 'whsec_x').update(`${t}.${payload}`).digest('hex')}`;

function stand({ sales = true, purchaseError = null, account = 'acct_1', target = 'acct_1' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.Authorization, body: init.body });
    const name = url.split('/rpc/')[1];
    if (name === 'app_flags') return Response.json({ sales_enabled: sales });
    if (name === 'begin_purchase') return purchaseError ? Response.json({ message: purchaseError }, { status: 400 }) : Response.json({ order_id: 'o-1', title: 'Harbour', amount_cents: 90000, fee_cents: 18000, currency: 'usd' });
    if (name === 'order_payout_target') return Response.json(target);
    if (name === 'payout_account_for') return Response.json(account);
    if (name) return Response.json(name === 'complete_order' ? 'paid' : 'ok');
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'u-1', email: 'ana@example.com' });
    if (url.includes('api.stripe.com')) return Response.json({ id: url.endsWith('/accounts') ? 'acct_new' : 'cs_1', url: 'https://checkout.stripe.example/x' });
    return new Response('{}', { status: 404 });
  };
  return { calls, fetchImpl };
}

test('buying is off unless switched on in Vercel and in the database', async () => {
  for (const env of [{}, { ...ENV, SALES_ENABLED: 'false' }]) {
    const { fetchImpl, calls } = stand();
    assert.equal((await createCheckout({ fetchImpl, env })({ method: 'POST', token: 't', body: { action: 'buy', artworkId: 'u_1' } })).status, 503);
    assert.equal(calls.length, 0);
  }
  const { fetchImpl, calls } = stand({ sales: false });
  assert.equal((await createCheckout({ fetchImpl, env: ENV })({ method: 'POST', token: 't', body: { action: 'buy', artworkId: 'u_1' } })).status, 503);
  assert.equal(calls.some((c) => c.url.includes('stripe.com')), false);
});

test('buy: the database creates the order; the session pays the artist directly and keeps the 20% fee', async () => {
  const { fetchImpl, calls } = stand();
  const out = await createCheckout({ fetchImpl, env: ENV })({ method: 'POST', token: 'buyer-token', body: { action: 'buy', artworkId: 'u_1' } });
  assert.equal(out.status, 200);
  assert.equal(calls.find((c) => c.url.endsWith('/rpc/begin_purchase')).auth, 'Bearer buyer-token', 'as the buyer');
  assert.equal(calls.find((c) => c.url.endsWith('/rpc/order_payout_target')).auth, 'Bearer service');
  const form = new URLSearchParams(calls.find((c) => c.url.endsWith('/checkout/sessions')).body);
  assert.equal(form.get('mode'), 'payment');
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '90000');
  assert.equal(form.get('payment_intent_data[application_fee_amount]'), '18000');
  assert.equal(form.get('payment_intent_data[transfer_data][destination]'), 'acct_1');
  assert.equal(form.get('metadata[order_id]'), 'o-1');
  assert.equal(form.get('shipping_address_collection[allowed_countries][0]'), SHIP_TO[0]);
  assert.equal(form.get('automatic_tax[enabled]'), null, 'no automatic tax (handled with the accountant)');
  assert.ok(calls.some((c) => c.url.endsWith('/rpc/attach_checkout_session')));
  const refused = stand({ purchaseError: 'Someone is already buying this work' });
  const r = await createCheckout({ fetchImpl: refused.fetchImpl, env: ENV })({ method: 'POST', token: 't', body: { action: 'buy', artworkId: 'u_1' } });
  assert.deepEqual([r.status, r.body.error], [400, 'Someone is already buying this work']);
  assert.equal(refused.calls.some((c) => c.url.includes('stripe.com')), false);
});

test('payout setup creates one Express account per artist and returns Stripe’s onboarding link', async () => {
  const { fetchImpl, calls } = stand({ account: null });
  const out = await createCheckout({ fetchImpl, env: ENV })({ method: 'POST', token: 't', body: { action: 'onboard', country: 'PT' } });
  assert.equal(out.status, 200);
  const acct = new URLSearchParams(calls.find((c) => c.url.endsWith('/v1/accounts')).body);
  assert.deepEqual([acct.get('type'), acct.get('country'), acct.get('metadata[user_id]')], ['express', 'PT', 'u-1']);
  assert.ok(calls.some((c) => c.url.endsWith('/rpc/set_payout_account') && c.auth === 'Bearer service'));
  assert.ok(calls.some((c) => c.url.endsWith('/v1/account_links')));
  const existing = stand({ account: 'acct_9' });
  await createCheckout({ fetchImpl: existing.fetchImpl, env: ENV })({ method: 'POST', token: 't', body: { action: 'onboard' } });
  assert.equal(existing.calls.some((c) => c.url.endsWith('/v1/accounts')), false, 'never a second account');
});

test('the webhook records paid checkouts, refunds and payout status, only when signed and switched on', async () => {
  const now = () => 5000;
  const ev = (type, object) => JSON.stringify({ id: 'evt_1', type, data: { object } });
  const { fetchImpl, calls } = stand();
  const hook = createWebhook({ fetchImpl, env: ENV, now });
  const paid = ev('checkout.session.completed', { id: 'cs_1', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 90000,
    metadata: { order_id: 'o-1' }, collected_information: { shipping_details: { name: 'Cy Park', address: { city: 'Seoul' } } } });
  assert.equal((await hook(paid, 'bad')).status, 400);
  assert.deepEqual(await hook(paid, sign(paid, 4999)), { status: 200, body: { result: 'paid' } });
  const args = JSON.parse(calls.find((c) => c.url.endsWith('/rpc/complete_order')).body);
  assert.deepEqual(args, { p_session: 'cs_1', p_payment_intent: 'pi_1', p_amount: 90000, p_shipping: { name: 'Cy Park', address: { city: 'Seoul' } } });
  const refund = ev('charge.refunded', { payment_intent: 'pi_1', refunded: true });
  await hook(refund, sign(refund, 4999));
  assert.ok(calls.some((c) => c.url.endsWith('/rpc/refund_order')));
  const acct = ev('account.updated', { id: 'acct_1', charges_enabled: true, payouts_enabled: true, details_submitted: true });
  await hook(acct, sign(acct, 4999));
  assert.deepEqual(JSON.parse(calls.find((c) => c.url.endsWith('/rpc/update_payout_status')).body), { p_account: 'acct_1', p_charges: true, p_payouts: true, p_details: true });
  const connect = createWebhook({ fetchImpl, env: { ...ENV, STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect' }, now });
  const signedByConnect = `t=4999,v1=${createHmac('sha256', 'whsec_connect').update(`4999.${acct}`).digest('hex')}`;
  assert.equal((await connect(acct, signedByConnect)).status, 200, 'the Connect endpoint’s secret works too');
  const off = createWebhook({ fetchImpl, env: { ...ENV, SALES_ENABLED: 'false', BILLING_ENABLED: 'true' }, now });
  assert.equal((await off(paid, sign(paid, 4999))).status, 503, 'sales events refused while sales are off');
});
