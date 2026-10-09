import test from 'node:test';
import assert from 'node:assert/strict';
import { bootPactwire, bootAgent, inMinutes } from './helpers.mjs';
import { pactwireClient, makeOffer, actionFor, signAs } from '../src/agent-kit.mjs';
import { verifyChain, verifyReceipt } from '../src/receipts.mjs';
import { sha256Hex } from '../src/crypto.mjs';

const SUMMARY_CHECKS = [
  { type: 'json_schema', schema: { type: 'object', required: ['summary', 'wordCount', 'sourceSha256'], properties: { summary: { type: 'string', minLength: 10, maxLength: 200 }, wordCount: { type: 'integer', minimum: 1 }, sourceSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' } } } },
  { type: 'max_bytes', bytes: 2000 }
];
const SOURCE = 'Agents need a way to hold money until work is checked. Pactwire holds it and settles by rules both sides signed.';
const honestWork = async task => ({ summary: task.text.split('.')[0].slice(0, 120) + '.', wordCount: task.text.split(/\s+/).length, sourceSha256: await sha256Hex(task.text) });

test('honest seller is paid, cheating seller is not, and the whole log verifies offline', async t => {
  const hs = await bootPactwire();
  const buyer = await bootAgent({ name: 'Research Buyer' });
  const honest = await bootAgent({ name: 'Honest Summarizer', skills: [{ id: 'summarize', name: 'Summarize', description: 'Summarize text', tags: ['text'] }], work: honestWork });
  const cheat = await bootAgent({ name: 'Cheap Summarizer', skills: [{ id: 'summarize', name: 'Summarize', description: 'Summarize text', tags: ['text'] }], work: async () => ({ summary: 'ok' }) });
  t.after(() => Promise.all([hs.close(), buyer.close(), honest.close(), cheat.close()]));
  const api = pactwireClient(hs.base);

  for (const a of [buyer, honest, cheat]) { const r = await api.register(a.origin); assert.equal(r.verified, true, `${a.origin} verified`); }
  const found = await api.agents({ q: 'summarize' });
  assert.equal(found.agents.length, 2);
  await api.faucet(buyer.origin, 1000);

  // Honest deal: proposed -> seller auto-accepts over A2A -> funded -> dispatched -> delivered -> checks pass -> released
  const offer = await makeOffer(buyer.identity, { seller: honest.origin, skill: 'summarize', task: { text: SOURCE }, amount: 250, acceptance: SUMMARY_CHECKS, deliverBy: inMinutes(30) });
  let deal = await api.propose(offer);
  assert.equal(deal.state, 'accepted', 'seller accepted automatically over A2A');
  deal = await api.fund(deal.id, await actionFor(buyer.identity, deal, 'fund'));
  assert.equal(deal.state, 'released', JSON.stringify(deal.verdict));
  assert.equal(deal.verdict.pass, true);
  assert.deepEqual((await api.balance(buyer.origin)).balance, 750);
  assert.deepEqual((await api.balance(honest.origin)).balance, 250);
  assert.deepEqual(deal.receipts.map(r => r.payload.kind), ['deal.proposed', 'deal.accepted', 'deal.funded', 'deal.dispatched', 'deal.delivered', 'deal.verified', 'deal.released']);

  // Cheating deal: delivery fails the schema -> refunded, buyer whole again
  const offer2 = await makeOffer(buyer.identity, { seller: cheat.origin, skill: 'summarize', task: { text: SOURCE }, amount: 300, acceptance: SUMMARY_CHECKS, deliverBy: inMinutes(30) });
  let deal2 = await api.propose(offer2);
  deal2 = await api.fund(deal2.id, await actionFor(buyer.identity, deal2, 'fund'));
  assert.equal(deal2.state, 'refunded');
  assert.match(deal2.verdict.results[0].detail, /missing wordCount/);
  assert.equal((await api.balance(buyer.origin)).balance, 750);
  assert.equal((await api.balance(cheat.origin)).balance, 0);

  // Track records come only from settled deals
  const rec = await api.record(honest.origin);
  assert.equal(rec.payload.sandbox.seller.passed, 1);
  assert.equal(rec.payload.seller.passed, 0, 'play money never counts as a real track record');
  assert.equal((await api.record(cheat.origin)).payload.sandbox.seller.failedOrLate, 1);

  // Whole public log verifies offline with only the public key; any edit is detected
  const pub = await api.jwks();
  const { receipts } = await api.log(0);
  const ok = await verifyChain(receipts, pub);
  assert.equal(ok.ok, true, ok.problems.join('; '));
  const forged = structuredClone(receipts);
  forged.find(r => r.payload.kind === 'deal.refunded').payload.data.paidTo = honest.origin;
  assert.equal((await verifyChain(forged, pub)).ok, false);
  const dropped = receipts.filter((_, i) => i !== 3);
  assert.equal((await verifyChain(dropped, pub)).ok, false, 'removing a receipt breaks the chain');
  assert.equal((await verifyReceipt(receipts[0], pub)).ok, true);
});

test('signatures, replays and state rules are enforced', async t => {
  const hs = await bootPactwire();
  const buyer = await bootAgent({ name: 'Buyer' });
  const seller = await bootAgent({ name: 'Manual Seller', skills: [{ id: 'echo', name: 'Echo', description: 'echo' }], decideOffer: async () => false, work: async x => x });
  const mallory = await bootAgent({ name: 'Mallory' });
  t.after(() => Promise.all([hs.close(), buyer.close(), seller.close(), mallory.close()]));
  const api = pactwireClient(hs.base);
  for (const a of [buyer, seller, mallory]) await api.register(a.origin);
  await api.faucet(buyer.origin, 500);
  const acceptance = [{ type: 'field_equals', path: 'echo', value: 'hi' }];

  // Mallory cannot propose in the buyer's name
  const fake = await signAs(mallory.identity, { v: 'pactwire/1', buyer: buyer.origin, seller: seller.origin, skill: 'echo', task: {}, price: { amount: 100, currency: 'usd' }, acceptance, deliverBy: inMinutes(10), rail: 'sandbox', nonce: 'nonce-12345' });
  await assert.rejects(api.propose(fake), e => e.code === 'wrong_signer');
  // Signed by Mallory's key but claiming to be the buyer
  const spoof = { ...fake, signer: buyer.origin };
  await assert.rejects(api.propose(spoof), e => e.code === 'bad_signature');

  const offer = await makeOffer(buyer.identity, { seller: seller.origin, skill: 'echo', task: { echo: 'hi' }, amount: 100, acceptance, deliverBy: inMinutes(10), dispatch: false });
  let deal = await api.propose(offer);
  assert.equal(deal.state, 'proposed', 'seller declined auto-accept');
  // Same offer twice gives the same deal, not a second one
  assert.equal((await api.propose(offer)).id, deal.id);
  // Funding before acceptance is refused
  await assert.rejects(api.fund(deal.id, await actionFor(buyer.identity, deal, 'fund')), e => e.code === 'bad_state');
  // Acceptance signed by someone else is refused
  await assert.rejects(api.accept(deal.id, await actionFor(mallory.identity, deal, 'accept')), e => e.code === 'wrong_signer');
  // Acceptance for a different terms hash is refused
  await assert.rejects(api.accept(deal.id, await signAs(seller.identity, { action: 'accept', dealId: deal.id, termsHash: 'f'.repeat(64) })), e => e.code === 'terms_mismatch');
  deal = await api.accept(deal.id, await actionFor(seller.identity, deal, 'accept'));
  deal = await api.fund(deal.id, await actionFor(buyer.identity, deal, 'fund'));
  assert.equal(deal.state, 'funded');
  assert.equal((await api.balance(buyer.origin)).balance, 400, 'money is held');
  // Buyer cannot claw back after funding
  await assert.rejects(api.cancel(deal.id, await actionFor(buyer.identity, deal, 'cancel')), e => e.code === 'bad_state');
  // Mallory cannot deliver for the seller
  await assert.rejects(api.deliver(deal.id, await actionFor(mallory.identity, deal, 'deliver', { output: { echo: 'hi' } })), e => e.code === 'wrong_signer');
  deal = await api.deliver(deal.id, await actionFor(seller.identity, deal, 'deliver', { output: { echo: 'hi' } }));
  assert.equal(deal.state, 'released');
  // A second delivery cannot settle twice
  await assert.rejects(api.deliver(deal.id, await actionFor(seller.identity, deal, 'deliver', { output: { echo: 'hi' } })), e => e.code === 'bad_state');
  assert.equal((await api.balance(seller.origin)).balance, 100);
});

test('no delivery by the deadline refunds the buyer automatically', async t => {
  let clock = Date.now();
  const hs = await bootPactwire({ now: () => new Date(clock) });
  const buyer = await bootAgent({ name: 'Buyer' });
  const slow = await bootAgent({ name: 'Slow Seller', skills: [{ id: 'echo', name: 'Echo', description: 'echo' }], work: async () => { throw new Error('busy'); } });
  t.after(() => Promise.all([hs.close(), buyer.close(), slow.close()]));
  const api = pactwireClient(hs.base);
  await api.register(buyer.origin); await api.register(slow.origin); await api.faucet(buyer.origin, 200);
  let deal = await api.propose(await makeOffer(buyer.identity, { seller: slow.origin, skill: 'echo', task: {}, amount: 200, acceptance: [{ type: 'max_bytes', bytes: 100 }], deliverBy: new Date(clock + 5 * 60000).toISOString() }));
  deal = await api.fund(deal.id, await actionFor(buyer.identity, deal, 'fund'));
  assert.equal(deal.state, 'funded');
  assert.ok(deal.receipts.some(r => r.payload.kind === 'deal.dispatch_failed'));
  assert.equal((await api.balance(buyer.origin)).balance, 0);
  clock += 6 * 60000;
  assert.deepEqual(await hs.app.scheduled(), [deal.id]);
  deal = await api.deal(deal.id);
  assert.equal(deal.state, 'refunded');
  assert.equal((await api.balance(buyer.origin)).balance, 200);
  // A delivery after the deadline is refused
  await assert.rejects(api.deliver(deal.id, await actionFor(slow.identity, deal, 'deliver', { output: {} })), e => e.code === 'bad_state');
});

test('an independent verifier agent can decide subjective checks with a signed attestation', async t => {
  const hs = await bootPactwire();
  const buyer = await bootAgent({ name: 'Buyer' });
  const seller = await bootAgent({ name: 'Translator', skills: [{ id: 'translate', name: 'Translate', description: 'en->fr' }], work: async task => ({ fr: task.en === 'hello' ? 'bonjour' : '???' }) });
  const verifier = await bootAgent({ name: 'French Checker', skills: [{ id: 'verify_fr', name: 'Verify French', description: 'checks translations' }], verify: async output => ({ verdict: output.fr === 'bonjour' ? 'pass' : 'fail', reason: 'dictionary lookup' }) });
  t.after(() => Promise.all([hs.close(), buyer.close(), seller.close(), verifier.close()]));
  const api = pactwireClient(hs.base);
  for (const a of [buyer, seller, verifier]) await api.register(a.origin);
  await api.faucet(buyer.origin, 1000);
  const acceptance = [{ type: 'verifier_agent', agent: verifier.origin }];
  let good = await api.propose(await makeOffer(buyer.identity, { seller: seller.origin, skill: 'translate', task: { en: 'hello' }, amount: 100, acceptance, deliverBy: inMinutes(10) }));
  good = await api.fund(good.id, await actionFor(buyer.identity, good, 'fund'));
  assert.equal(good.state, 'released');
  assert.match(good.verdict.results[0].detail, /pass/);
  assert.equal(good.verdict.results[0].attestation.signer, verifier.origin);
  let bad = await api.propose(await makeOffer(buyer.identity, { seller: seller.origin, skill: 'translate', task: { en: 'cat' }, amount: 100, acceptance, deliverBy: inMinutes(10) }));
  bad = await api.fund(bad.id, await actionFor(buyer.identity, bad, 'fund'));
  assert.equal(bad.state, 'refunded');
  // The seller cannot name itself as the verifier
  let self = await api.propose(await makeOffer(buyer.identity, { seller: seller.origin, skill: 'translate', task: { en: 'hello' }, amount: 100, acceptance: [{ type: 'verifier_agent', agent: seller.origin }], deliverBy: inMinutes(10) }));
  self = await api.fund(self.id, await actionFor(buyer.identity, self, 'fund'));
  assert.equal(self.state, 'refunded');
  assert.match(self.verdict.results[0].detail, /independent|not a verified/);
});

test('two simultaneous fund calls hold the money once', async t => {
  const hs = await bootPactwire();
  const buyer = await bootAgent({ name: 'Buyer' });
  const seller = await bootAgent({ name: 'Seller', skills: [{ id: 'echo', name: 'Echo', description: 'echo' }] });
  t.after(() => Promise.all([hs.close(), buyer.close(), seller.close()]));
  const api = pactwireClient(hs.base);
  await api.register(buyer.origin); await api.register(seller.origin); await api.faucet(buyer.origin, 1000);
  const deal = await api.propose(await makeOffer(buyer.identity, { seller: seller.origin, skill: 'echo', task: {}, amount: 300, acceptance: [{ type: 'max_bytes', bytes: 100 }], deliverBy: inMinutes(10), dispatch: false }));
  assert.equal(deal.state, 'accepted');
  const auth = await actionFor(buyer.identity, deal, 'fund');
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => api.fund(deal.id, auth)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, JSON.stringify(results.map(r => r.reason?.code)));
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 409));
  assert.equal((await api.balance(buyer.origin)).balance, 700);
  assert.equal((await api.deal(deal.id)).state, 'funded');
});

test('stripe deals must name the seller payout account', async t => {
  const hs = await bootPactwire({ extraRails: { stripe: { name: 'stripe', maxHoldDays: 6, hold: async () => ({ ref: 'pi_x', status: 'held' }), capture: async () => ({}), release: async () => ({}) } } });
  const buyer = await bootAgent({ name: 'Buyer' });
  const seller = await bootAgent({ name: 'Seller', skills: [{ id: 'echo', name: 'Echo', description: 'echo' }] });
  t.after(() => Promise.all([hs.close(), buyer.close(), seller.close()]));
  const api = pactwireClient(hs.base);
  await api.register(buyer.origin); await api.register(seller.origin);
  await assert.rejects(api.propose(await makeOffer(buyer.identity, { seller: seller.origin, skill: 'echo', task: {}, amount: 300, rail: 'stripe', acceptance: [{ type: 'max_bytes', bytes: 100 }], deliverBy: inMinutes(10) })), e => /payout/.test(e.message));
  const ok = await api.propose(await makeOffer(buyer.identity, { seller: seller.origin, skill: 'echo', task: {}, amount: 300, rail: 'stripe', payout: { stripeAccount: 'acct_1Abc' }, acceptance: [{ type: 'max_bytes', bytes: 100 }], deliverBy: inMinutes(10) }));
  assert.equal(ok.state, 'accepted');
});

test('sandbox guest buyers can only buy, only with play money', async t => {
  const hs = await bootPactwire();
  const seller = await bootAgent({ name: 'Seller', skills: [{ id: 'echo', name: 'Echo', description: 'echo' }], work: async x => x });
  t.after(() => Promise.all([hs.close(), seller.close()]));
  const api = pactwireClient(hs.base);
  await api.register(seller.origin);
  const { createIdentity } = await import('../src/agent-kit.mjs');
  const tmp = await createIdentity('https://x.invalid');
  const g = await api.guest(tmp.publicJwk, 'guest');
  assert.match(g.id, /^https:\/\/guest-[0-9a-f]{24}\.invalid$/);
  const me = { ...tmp, origin: g.id };
  await api.faucet(me.origin, 100);
  let deal = await api.propose(await makeOffer(me, { seller: seller.origin, skill: 'echo', task: { a: 1 }, amount: 100, acceptance: [{ type: 'field_equals', path: 'a', value: 1 }], deliverBy: inMinutes(5) }));
  deal = await api.fund(deal.id, await actionFor(me, deal, 'fund'));
  assert.equal(deal.state, 'released');
  // A guest can never sell
  const sellerAsBuyer = await makeOffer(seller.identity, { seller: me.origin, skill: 'echo', task: {}, amount: 1, acceptance: [{ type: 'max_bytes', bytes: 10 }], deliverBy: inMinutes(5) });
  await assert.rejects(api.propose(sellerAsBuyer), e => /only buy/.test(e.message));
});
