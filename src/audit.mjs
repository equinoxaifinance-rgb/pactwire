// Independent audit: lets anyone (not Pactwire) re-check the public log and any deal.
// It trusts nothing the service says except what is signed: it rebuilds agent keys and
// track records from the log itself, re-hashes terms, re-verifies every party signature,
// and, when you have the delivered output (you are the buyer or seller), re-runs the checks.

import { verify, hashJson } from './crypto.mjs';
import { verifyChain } from './receipts.mjs';
import { runChecks } from './checks.mjs';

const OFFLINE = new Set(['url_content_hash', 'verifier_agent']);

/** Read the whole log: chain validity, every agent's key history, and each deal's receipts. */
export async function auditLog(receipts, jwks) {
  const chain = await verifyChain(receipts, jwks);
  const keys = new Map(); // agent -> [{ seq, kid, publicJwk }]
  const deals = new Map(); // dealId -> receipts
  for (const r of receipts) {
    const p = r.payload;
    if (p.kind === 'agent.key') { const list = keys.get(p.data.agent) || []; list.push({ seq: p.seq, kid: p.data.kid, publicJwk: p.data.publicJwk }); keys.set(p.data.agent, list); }
    if (p.dealId) { const list = deals.get(p.dealId) || []; list.push(r); deals.set(p.dealId, list); }
  }
  return { chain, keys, deals };
}

/** The key an agent had registered when receipt `seq` was written. */
export function keyAt(keys, agent, seq) {
  const list = (keys.get(agent) || []).filter(k => k.seq < seq);
  return list.at(-1)?.publicJwk || null;
}

/** Rebuild an agent's track record from the log alone, to compare with the record Pactwire signs. */
export function recordFromLog(audit, agent) {
  const tally = { real: blank(), sandbox: blank() };
  for (const [, rs] of audit.deals) {
    const proposed = rs.find(r => r.payload.kind === 'deal.proposed')?.payload.data;
    const settled = rs.find(r => ['deal.released', 'deal.refunded'].includes(r.payload.kind));
    if (!proposed || !settled) continue;
    const t = proposed.rail === 'sandbox' ? tally.sandbox : tally.real;
    const released = settled.payload.kind === 'deal.released';
    if (proposed.seller === agent) {
      t.seller.settledDeals++; released ? t.seller.passed++ : t.seller.failedOrLate++;
      if (released) { t._buyers.add(proposed.buyer); const c = proposed.price.currency; t.seller.paidMinorUnitsByCurrency[c] = (t.seller.paidMinorUnitsByCurrency[c] || 0) + proposed.price.amount; }
      if (rs.some(r => r.payload.kind === 'deal.disputed')) t.seller.disputed++;
    }
    if (proposed.buyer === agent) { t.buyer.settledDeals++; t._sellers.add(proposed.seller); }
  }
  const out = x => ({ seller: { ...x.seller, distinctPayingBuyers: x._buyers.size }, buyer: { ...x.buyer, distinctSellers: x._sellers.size } });
  return { real: out(tally.real), sandbox: out(tally.sandbox) };
  function blank() { return { seller: { settledDeals: 0, passed: 0, failedOrLate: 0, paidMinorUnitsByCurrency: {}, disputed: 0 }, buyer: { settledDeals: 0 }, _buyers: new Set(), _sellers: new Set() }; }
}

/** Compare Pactwire's signed record with the one rebuilt from the log. Returns a list of differences. */
export async function compareRecord(signedRecord, audit, jwks) {
  const problems = [];
  const keyList = Array.isArray(jwks?.keys) ? jwks.keys : [jwks];
  if (!(await Promise.all(keyList.map(k => verify(signedRecord, k)))).some(Boolean)) problems.push('record signature does not verify against the service keys');
  const mine = recordFromLog(audit, signedRecord.payload.agent);
  const theirs = signedRecord.payload;
  for (const [label, a, b] of [['real money', mine.real, theirs], ['play money', mine.sandbox, theirs.sandbox]])
    for (const k of ['settledDeals', 'passed', 'failedOrLate', 'distinctPayingBuyers', 'disputed'])
      if (a.seller[k] !== b.seller[k]) problems.push(`${label} seller.${k}: log says ${a.seller[k]}, Pactwire says ${b.seller[k]}`);
  return { ok: problems.length === 0, problems, fromLog: mine };
}

/**
 * Audit one deal as returned by GET /v1/deals/{id} (the public view, or the full view if you are a party).
 * Every statement in the result is something this code checked itself.
 */
export async function auditDeal(deal, audit) {
  const findings = []; const ok = (pass, what) => findings.push({ pass, what });
  const rs = audit.deals.get(deal.id) || [];
  const kind = k => rs.find(r => r.payload.kind === k);
  const proposed = kind('deal.proposed');
  ok(!!proposed, 'the deal is in the public log');
  if (!proposed) return { ok: false, findings };
  const termsHash = await hashJson(deal.terms);
  ok(termsHash === proposed.payload.data.termsHash, 'the terms hash to the termsHash in the log');
  ok(deal.id === `deal_${termsHash.slice(0, 24)}`, 'the deal id comes from the terms hash');
  ok(deal.offer.sig === proposed.payload.data.offerSig, 'the offer is the one recorded in the log');
  const buyerKey = keyAt(audit.keys, deal.terms.buyer, proposed.payload.seq);
  ok(!!buyerKey && await verify(deal.offer, buyerKey) && await hashJson(deal.offer.payload) === termsHash, "the buyer's key (from the log) signed these exact terms");
  const accepted = kind('deal.accepted');
  if (accepted) {
    const sellerKey = keyAt(audit.keys, deal.terms.seller, accepted.payload.seq);
    ok(deal.acceptance?.sig === accepted.payload.data.acceptSig && !!sellerKey && await verify(deal.acceptance, sellerKey) && deal.acceptance.payload.termsHash === termsHash, "the seller's key signed acceptance of the same terms");
  }
  const funded = kind('deal.funded');
  if (funded) ok(funded.payload.data.amount === deal.terms.price.amount && funded.payload.data.currency === deal.terms.price.currency, 'the amount held equals the agreed price');
  const delivered = kind('deal.delivered'); const verified = kind('deal.verified');
  const released = kind('deal.released'); const refunded = kind('deal.refunded');
  ok(!(released && refunded), 'the deal settled at most once');
  if (delivered && verified) {
    ok(delivered.payload.data.outputHash === verified.payload.data.outputHash, 'the checks ran on the delivered output');
    ok(!!released === (verified.payload.data.pass === true && !delivered.payload.data.late), 'the money went where the check verdict says');
    const output = deal.delivery?.payload?.output;
    if (output !== undefined) {
      const sellerKey = keyAt(audit.keys, deal.terms.seller, delivered.payload.seq);
      ok(deal.delivery.sig === delivered.payload.data.deliverSig && !!sellerKey && await verify(deal.delivery, sellerKey), "the seller's key signed this output");
      ok(await hashJson(output) === delivered.payload.data.outputHash, 'this output hashes to the outputHash in the log');
      const offline = deal.terms.acceptance.map((c, i) => ({ c, i })).filter(x => !OFFLINE.has(x.c.type));
      const rerun = await runChecks(offline.map(x => x.c), output, { task: deal.terms.task });
      const logged = verified.payload.data.results;
      const same = offline.every((x, j) => logged.find(r => r.index === x.i)?.pass === rerun.results[j].pass);
      ok(same, `re-running the ${offline.length} offline check(s) here gives the same verdicts as the log`);
      for (const r of logged.filter(r => OFFLINE.has(r.type))) findings.push({ pass: null, what: `${r.type} (#${r.index}) was not re-run here; the log records ${r.pass ? 'pass' : 'fail'}${r.attestedBy ? `, signed by ${r.attestedBy}` : ''}` });
    } else findings.push({ pass: null, what: 'output not visible (only the buyer and seller can see it), so checks were not re-run' });
  }
  return { ok: findings.every(f => f.pass !== false), findings, state: deal.state };
}
