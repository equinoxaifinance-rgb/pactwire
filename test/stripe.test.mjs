// The Stripe rail against stripe-mock (Stripe's official API mock, which validates every
// request against Stripe's real OpenAPI spec). Set STRIPE_MOCK=http://127.0.0.1:12111 to run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripeRail, RailError } from '../src/rails.mjs';

const MOCK = process.env.STRIPE_MOCK;
const deal = { id: 'deal_abcdefabcdefabcdefabcdef', amount: 500, currency: 'usd', buyer: 'https://b.example', seller: 'https://s.example', terms_hash: 'a'.repeat(64), payout: { stripeAccount: 'acct_123' }, fee: 25 };

test('stripe rail sends valid hold, capture and cancel calls', { skip: !MOCK && 'set STRIPE_MOCK to run against stripe-mock' }, async () => {
  const seen = [];
  const rail = stripeRail({ secretKey: 'sk_test_123', apiBase: MOCK, fetchImpl: async (url, init) => { seen.push({ url, body: String(init.body), key: init.headers['idempotency-key'] }); return fetch(url, init); } });
  rail.acceptAnyStatus = true; // stripe-mock returns fixed fixtures, not real authorization states
  const held = await rail.hold(deal, { payment_method: 'pm_card_visa' });
  assert.match(held.ref, /^pi_/);
  assert.match(seen[0].body, /capture_method=manual/);
  assert.match(seen[0].body, /transfer_data%5Bdestination%5D=acct_123/);
  assert.match(seen[0].body, /application_fee_amount=25/);
  assert.equal(seen[0].key, `hs-hold-${deal.id}`);
  assert.deepEqual(await rail.capture(deal, held.ref), { status: 'captured' });
  assert.deepEqual(await rail.release(deal, held.ref), { status: 'released' });
  assert.match(seen[1].url, /\/capture$/);
  assert.match(seen[2].url, /\/cancel$/);
});

test('stripe rail refuses an authorization that is not held', async () => {
  const rail = stripeRail({ secretKey: 'sk_test_x', fetchImpl: async () => new Response(JSON.stringify({ id: 'pi_1', status: 'requires_action' }), { status: 200 }) });
  await assert.rejects(rail.hold(deal, { payment_method: 'pm_x' }), RailError);
  await assert.rejects(rail.hold(deal, {}), /payment_method/);
  await assert.rejects(rail.hold({ ...deal, payout: undefined }, { payment_method: 'pm_x' }), /Connect account/);
  const declined = stripeRail({ secretKey: 'sk_test_x', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Your card was declined.' } }), { status: 402 }) });
  await assert.rejects(declined.hold(deal, { payment_method: 'pm_x' }), /declined/);
});

test('a disputed card payment is recorded openly on the deal, the log and the track record', async t => {
  const { bootPactwire, bootAgent, inMinutes } = await import('./helpers.mjs');
  const { pactwireClient, makeOffer, actionFor } = await import('../src/agent-kit.mjs');
  const fakeStripe = { name: 'stripe', maxHoldDays: 6, hold: async d => ({ ref: `pi_test_${d.id.slice(5, 15)}`, status: 'held' }), capture: async () => ({ status: 'captured' }), release: async () => ({ status: 'released' }) };
  const secret = 'whsec_test_secret';
  const hs = await bootPactwire({ extraRails: { stripe: fakeStripe }, stripeWebhookSecret: secret });
  const buyer = await bootAgent({ name: 'Buyer' });
  const seller = await bootAgent({ name: 'Seller', skills: [{ id: 'echo', name: 'Echo', description: 'echo' }], work: async x => x });
  t.after(() => Promise.all([hs.close(), buyer.close(), seller.close()]));
  const api = pactwireClient(hs.base);
  await api.register(buyer.origin); await api.register(seller.origin);
  let deal = await api.propose(await makeOffer(buyer.identity, { seller: seller.origin, skill: 'echo', task: { a: 1 }, amount: 500, rail: 'stripe', payout: { stripeAccount: 'acct_1X' }, acceptance: [{ type: 'field_equals', path: 'a', value: 1 }], deliverBy: inMinutes(10) }));
  deal = await api.fund(deal.id, await actionFor(buyer.identity, deal, 'fund'), { payment_method: 'pm_x' });
  assert.equal(deal.state, 'released');
  const body = JSON.stringify({ type: 'charge.dispute.created', data: { object: { id: 'dp_1', status: 'needs_response', payment_intent: `pi_test_${deal.id.slice(5, 15)}` } } });
  const ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const bad = await fetch(`${hs.base}/v1/stripe/webhook`, { method: 'POST', body, headers: { 'stripe-signature': `t=${ts},v1=${'0'.repeat(64)}` } });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${hs.base}/v1/stripe/webhook`, { method: 'POST', body, headers: { 'stripe-signature': `t=${ts},v1=${sig}` } });
  assert.equal(ok.status, 200);
  const after = await api.deal(deal.id);
  assert.equal(after.dispute, 'needs_response');
  assert.equal(after.receipts.at(-1).payload.kind, 'deal.disputed');
  assert.equal((await api.record(seller.origin)).payload.seller.disputed, 1);
});
