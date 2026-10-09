// Try Pactwire in one minute, with nothing to host: you act as a sandbox guest buyer
// and hire the public practice agents.
//
//   node tools/try-deal.mjs <pactwire-url> <writer-url> <cutter-url> <checker-url>
//
// It registers the practice agents (harmless if already registered), creates a guest
// buyer key, gets play money, then runs two deals: one honest (paid) and one sloppy (refunded).
// It also works as a post-deploy check: it exits non-zero if anything is wrong.
import { createIdentity, pactwireClient, makeOffer, actionFor } from '../src/agent-kit.mjs';
import { verifyChain } from '../src/receipts.mjs';

const [base, writer, cutter, checker] = process.argv.slice(2).map(s => s?.replace(/\/$/, ''));
if (!base || !writer || !cutter || !checker) { console.error('usage: node tools/try-deal.mjs <pactwire> <writer> <cutter> <checker>'); process.exit(2); }
const api = pactwireClient(base);
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

for (const a of [writer, cutter, checker]) {
  const r = await api.register(a);
  check(r.verified, `${r.name} registered and verified (${a})`);
}
const temp = await createIdentity('https://placeholder.invalid');
const guest = await api.guest(temp.publicJwk, 'try-deal script');
const me = { ...temp, origin: guest.id };
check(/\.invalid$/.test(me.origin), `guest buyer created: ${me.origin}`);
await api.faucet(me.origin, 1000);

const sourceText = 'Agents can talk and pay. Nothing holds the money until the work is checked. Pactwire holds it and settles by rules both sides signed.';
const task = { topic: 'Agent escrow', sourceText };
const acceptance = [
  { type: 'json_schema', schema: { type: 'object', required: ['title', 'facts'], properties: { facts: { type: 'array', minItems: 3, items: { type: 'string' } } } } },
  { type: 'verifier_agent', agent: checker, sourceText }
];
const deliverBy = new Date(Date.now() + 20 * 60000).toISOString();

for (const [label, seller, expect] of [['honest writer', writer, 'released'], ['corner cutter', cutter, 'refunded']]) {
  let deal = await api.propose(await makeOffer(me, { seller, skill: 'fact_sheet', task, amount: 200, acceptance, deliverBy }));
  check(deal.state === 'accepted', `${label}: offer accepted by the seller over A2A (${deal.id})`);
  deal = await api.fund(deal.id, await actionFor(me, deal, 'fund'));
  check(deal.state === expect, `${label}: ${deal.state} (expected ${expect}); checks: ${(deal.verdict?.results || []).map(r => `${r.type}=${r.pass ? 'pass' : 'fail'}`).join(', ')}`);
}
check((await api.balance(me.origin)).balance === 800, 'guest balance is 1000 - 200 paid + 200 refunded = 800');
const pub = await api.jwks();
let after = 0; const all = [];
for (;;) { const { receipts } = await api.log(after); if (!receipts.length) break; all.push(...receipts); after = receipts.at(-1).payload.seq; }
const chain = await verifyChain(all, pub);
check(chain.ok, `public log: ${chain.count} receipts, every signature and link valid`);
console.log(failures ? `\n${failures} problem(s)` : '\nAll good.');
process.exit(failures ? 1 : 0);
