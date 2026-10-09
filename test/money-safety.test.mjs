// Money-safety regression tests: whatever order or timing the parties use, a funded deal
// settles exactly once, nobody ends up with both the work and the money, and money is conserved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootPactwire, bootAgent, inMinutes } from './helpers.mjs';
import { pactwireClient, makeOffer, actionFor, signAs, createIdentity } from '../src/agent-kit.mjs';
import { verifyChain } from '../src/receipts.mjs';
import { generateKeyPair } from '../src/crypto.mjs';

const ECHO = [{ id: 'echo', name: 'Echo', description: 'echo' }];
const acceptance = [{ type: 'field_equals', path: 'echo', value: 'hi' }];

async function setup(t, opts) {
  const hs = await bootPactwire(opts);
  const buyer = await bootAgent({ name: 'Buyer' });
  const seller = await bootAgent({ name: 'Seller', skills: ECHO });
  const other = await bootAgent({ name: 'Other', skills: ECHO });
  t.after(() => Promise.all([hs.close(), buyer.close(), seller.close(), other.close()]));
  const api = pactwireClient(hs.base);
  for (const a of [buyer, seller, other]) await api.register(a.origin);
  await api.faucet(buyer.origin, 1000);
  // dispatch:false, so the test decides when (and how often) the seller delivers.
  const funded = async (amount = 100, deliverBy = inMinutes(10)) => {
    const offer = await makeOffer(buyer.identity, { seller: seller.origin, skill: 'echo', task: {}, amount, acceptance, deliverBy, dispatch: false });
    let deal = await api.propose(offer);
    assert.equal(deal.state, 'accepted');
    deal = await api.fund(deal.id, await actionFor(buyer.identity, deal, 'fund'));
    assert.equal(deal.state, 'funded');
    return deal;
  };
  const total = async () => (await api.balance(buyer.origin)).balance + (await api.balance(seller.origin)).balance;
  const settledReceipts = async id => (await api.deal(id)).receipts.filter(r => ['deal.released', 'deal.refunded'].includes(r.payload.kind));
  return { hs, api, buyer, seller, other, funded, total, settledReceipts };
}

test('ten simultaneous deliveries and cancels settle a deal exactly once', async t => {
  const { api, seller, funded, total, settledReceipts } = await setup(t);
  const deal = await funded(100);
  const good = await actionFor(seller.identity, deal, 'deliver', { output: { echo: 'hi' } });
  const bad = await actionFor(seller.identity, deal, 'deliver', { output: { echo: 'no' } });
  const cancel = await actionFor(seller.identity, deal, 'cancel');
  const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => [() => api.deliver(deal.id, good), () => api.deliver(deal.id, bad), () => api.cancel(deal.id, cancel)][i % 3]()));
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1, 'exactly one attempt settles');
  assert.equal((await settledReceipts(deal.id)).length, 1, 'exactly one settlement receipt');
  assert.equal(await total(), 1000, 'no money created or lost');
  const final = await api.deal(deal.id);
  assert.ok(['released', 'refunded'].includes(final.state));
  // Once settled, nothing more can happen to the deal.
  await assert.rejects(api.deliver(deal.id, good), e => e.status === 409);
  await assert.rejects(api.cancel(deal.id, cancel), e => e.status === 409);
});

test('deadline sweep and a late delivery race: refunded once, seller never paid', async t => {
  let clock = Date.now();
  const { hs, api, seller, funded, total, settledReceipts } = await setup(t, { now: () => new Date(clock) });
  const deal = await funded(200, new Date(clock + 60000).toISOString());
  clock += 120000;
  const late = await actionFor(seller.identity, deal, 'deliver', { output: { echo: 'hi' } });
  await Promise.allSettled([hs.app.scheduled(), api.deliver(deal.id, late), hs.app.scheduled(), api.deliver(deal.id, late)]);
  const final = await api.deal(deal.id);
  assert.equal(final.state, 'refunded');
  assert.equal((await settledReceipts(deal.id)).length, 1);
  assert.equal((await api.balance(seller.origin)).balance, 0, 'late work is never paid');
  assert.equal(await total(), 1000);
});

test('signed actions cannot be reused on another deal, by another party, or for another action', async t => {
  const { api, buyer, seller, other, funded } = await setup(t);
  const a = await funded(100); const b = await funded(100);
  const forA = await actionFor(seller.identity, a, 'deliver', { output: { echo: 'hi' } });
  await assert.rejects(api.deliver(b.id, forA), e => e.status >= 400, 'delivery for deal A cannot settle deal B');
  const byBuyer = await actionFor(buyer.identity, b, 'deliver', { output: { echo: 'hi' } });
  await assert.rejects(api.deliver(b.id, byBuyer), e => e.status >= 400, 'buyer cannot deliver to pay themselves back');
  const byOther = await actionFor(other.identity, b, 'deliver', { output: { echo: 'hi' } });
  await assert.rejects(api.deliver(b.id, byOther), e => e.status >= 400, 'another agent cannot deliver');
  const wrongAction = await actionFor(seller.identity, b, 'cancel');
  await assert.rejects(api.deliver(b.id, wrongAction), e => e.status >= 400, 'a cancel cannot be used as a delivery');
  const stolenKey = await signAs({ ...other.identity, origin: seller.origin }, { action: 'deliver', dealId: b.id, termsHash: b.termsHash, output: { echo: 'hi' } });
  await assert.rejects(api.deliver(b.id, stolenKey), e => e.status >= 400, 'claiming the seller name without the seller key fails');
  const edited = { ...forA, payload: { ...forA.payload, dealId: b.id } };
  await assert.rejects(api.deliver(b.id, edited), e => e.status >= 400, 'editing a signed payload breaks it');
  assert.equal((await api.deal(b.id)).state, 'funded', 'deal B is untouched');
  const buyerCancel = await actionFor(buyer.identity, b, 'cancel');
  await assert.rejects(api.cancel(b.id, buyerCancel), e => e.status === 409, 'buyer cannot take money back after funding');
});

test('self-dealing and conflicted verifiers are refused', async t => {
  const { api, buyer, seller, other } = await setup(t);
  await assert.rejects(api.propose(await makeOffer(buyer.identity, { seller: buyer.origin, skill: 'echo', task: {}, amount: 10, acceptance, deliverBy: inMinutes(10) })), e => e.status >= 400, 'buyer cannot hire itself');
  for (const v of [buyer.origin, seller.origin]) {
    const offer = await makeOffer(buyer.identity, { seller: seller.origin, skill: 'echo', task: {}, amount: 10, deliverBy: inMinutes(10), dispatch: false, acceptance: [{ type: 'verifier_agent', agent: v }] });
    let d; try { d = await api.propose(offer); } catch { continue; } // refused up front: fine
    d = await api.fund(d.id, await actionFor(buyer.identity, d, 'fund'));
    d = await api.deliver(d.id, await actionFor(seller.identity, d, 'deliver', { output: { echo: 'hi' } }));
    assert.equal(d.state, 'refunded', `a party to the deal (${v}) cannot act as its verifier`);
  }
  // A sandbox guest can only buy with play money.
  const temp = await createIdentity('https://placeholder.invalid');
  const guest = await api.guest(temp.publicJwk, 'guest');
  const g = { ...temp, origin: guest.id };
  await assert.rejects(api.propose(await makeOffer(buyer.identity, { seller: g.origin, skill: 'echo', task: {}, amount: 10, acceptance, deliverBy: inMinutes(10) })), e => e.status >= 400, 'guests cannot sell');
  await assert.rejects(api.propose(await makeOffer(g, { seller: other.origin, skill: 'echo', task: {}, amount: 10, acceptance, deliverBy: inMinutes(10), rail: 'stripe', payout: { stripeAccount: 'acct_123' } })), e => e.status >= 400, 'guests cannot use real money');
});

test('a third party detects any edit, removal, reordering or forgery of the public log', async t => {
  const { api, seller, funded } = await setup(t);
  const d = await funded(100);
  await api.deliver(d.id, await actionFor(seller.identity, d, 'deliver', { output: { echo: 'hi' } }));
  const pub = await api.jwks(); const { receipts } = await api.log(0);
  assert.equal((await verifyChain(receipts, pub)).ok, true);
  const swap = [...receipts]; [swap[2], swap[3]] = [swap[3], swap[2]];
  assert.equal((await verifyChain(swap, pub)).ok, false, 'reordered');
  assert.equal((await verifyChain(receipts.slice(0, -2).concat(receipts.slice(-1)), pub)).ok, false, 'removed');
  const k = await generateKeyPair();
  const { sign } = await import('../src/crypto.mjs');
  const last = receipts.at(-1);
  const fake = { ...(await sign({ ...last.payload, data: { ...last.payload.data, paidTo: 'https://thief.example' } }, last.signer, k.privateJwk)), kid: last.kid };
  assert.equal((await verifyChain([...receipts.slice(0, -1), fake], pub)).ok, false, 'forged with another key');
  const amount = structuredClone(receipts); amount.find(r => r.payload.kind === 'deal.funded').payload.data.amount = 1;
  assert.equal((await verifyChain(amount, pub)).ok, false, 'edited amount');
});

test('outsiders cannot read the work the buyer paid for', async t => {
  const { hs, api, buyer, seller, other, funded } = await setup(t);
  const d = await funded(100);
  await api.deliver(d.id, await actionFor(seller.identity, d, 'deliver', { output: { echo: 'hi', secret: 'paid work' } }));
  const pub = await api.deal(d.id);
  assert.equal(pub.state, 'released');
  assert.equal(pub.delivery.payload.output, undefined);
  assert.match(pub.delivery.outputHash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(pub), /paid work/);
  assert.doesNotMatch(await (await fetch(`${hs.base}/v1/deals?party=${encodeURIComponent(buyer.origin)}`)).text(), /paid work/);
  assert.equal((await api.deal(d.id, buyer.identity)).delivery.payload.output.secret, 'paid work');
  assert.equal((await api.deal(d.id, seller.identity)).delivery.payload.output.secret, 'paid work');
  await assert.rejects(api.deal(d.id, other.identity), e => e.status === 403);
  // Failed work: the buyer is refunded and does not get the work; the seller keeps it.
  const f = await funded(100);
  const settled = await api.deliver(f.id, await actionFor(seller.identity, f, 'deliver', { output: { echo: 'wrong', secret: 'unpaid work' } }));
  assert.equal(settled.state, 'refunded');
  const asBuyer = await api.deal(f.id, buyer.identity);
  assert.doesNotMatch(JSON.stringify(asBuyer), /unpaid work/);
  assert.match(asBuyer.delivery.outputHidden, /refunded/);
  assert.equal(asBuyer.verdict.results[0].pass, false, 'the buyer still sees which check failed');
  assert.equal((await api.deal(f.id, seller.identity)).delivery.payload.output.secret, 'unpaid work');
});

test('an outside auditor rebuilds records from the log and re-runs a deal\'s checks', async t => {
  const { auditLog, auditDeal, compareRecord } = await import('../src/audit.mjs');
  const { api, buyer, seller, funded } = await setup(t);
  const d1 = await funded(100); await api.deliver(d1.id, await actionFor(seller.identity, d1, 'deliver', { output: { echo: 'hi' } }));
  const d2 = await funded(100); await api.deliver(d2.id, await actionFor(seller.identity, d2, 'deliver', { output: { echo: 'nope' } }));
  const jwks = await api.jwks(); const { receipts } = await api.log(0);
  const audit = await auditLog(receipts, jwks);
  assert.equal(audit.chain.ok, true);
  const cmp = await compareRecord(await api.record(seller.origin), audit, jwks);
  assert.equal(cmp.ok, true, cmp.problems.join('; '));
  assert.equal(cmp.fromLog.sandbox.seller.passed, 1); assert.equal(cmp.fromLog.sandbox.seller.failedOrLate, 1);
  // A record that claims more than the log shows is caught.
  const inflated = await api.record(seller.origin); inflated.payload.sandbox.seller.passed = 50;
  assert.equal((await compareRecord(inflated, audit, jwks)).ok, false);
  // As a party (buyer of the paid deal, seller of the refunded one), the auditor sees the output and re-runs the checks.
  for (const [d, who] of [[d1, buyer], [d2, seller]]) {
    const r = await auditDeal(await api.deal(d.id, who.identity), audit);
    assert.equal(r.ok, true, JSON.stringify(r.findings.filter(f => f.pass === false)));
    assert.ok(r.findings.some(f => /re-running/.test(f.what) && f.pass));
  }
  // Swapping in different output is caught.
  const tampered = await api.deal(d1.id, buyer.identity); tampered.delivery.payload.output = { echo: 'hi', extra: 1 };
  assert.equal((await auditDeal(tampered, audit)).ok, false);
  // Guest buyers' keys are in the log too, so their deals audit cleanly.
  const temp = await createIdentity('https://placeholder.invalid');
  const g = { ...temp, origin: (await api.guest(temp.publicJwk, 'guest')).id };
  await api.faucet(g.origin, 100);
  let gd = await api.propose(await makeOffer(g, { seller: seller.origin, skill: 'echo', task: {}, amount: 50, acceptance, deliverBy: inMinutes(10), dispatch: false }));
  gd = await api.fund(gd.id, await actionFor(g, gd, 'fund'));
  await api.deliver(gd.id, await actionFor(seller.identity, gd, 'deliver', { output: { echo: 'hi' } }));
  const audit2 = await auditLog((await api.log(0)).receipts, jwks);
  const ga = await auditDeal(await api.deal(gd.id, g), audit2);
  assert.equal(ga.ok, true, JSON.stringify(ga.findings.filter(f => f.pass === false)));
  // Public view: audits signatures and settlement without seeing the output.
  const pub = await auditDeal(await api.deal(d1.id), audit);
  assert.equal(pub.ok, true); assert.ok(pub.findings.some(f => f.pass === null && /not visible/.test(f.what)));
});
