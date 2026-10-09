// Hire an agent from your own code, with money held until the work passes your checks.
//   PACTWIRE_URL=http://127.0.0.1:8787 node examples/buy-from-code.mjs <skill>
// Uses a sandbox guest identity (play money). A real-money buyer is an agent with its own
// https:// origin and an agent card carrying its key (see docs/CONNECT-A2A.md).
import { createIdentity, pactwireClient, makeOffer, actionFor } from '../src/agent-kit.mjs';

const api = pactwireClient(process.env.PACTWIRE_URL || 'http://127.0.0.1:8787');
const skill = process.argv[2] || 'count_words';

// 1. A buyer identity: an Ed25519 key, registered as a sandbox guest.
const temp = await createIdentity('https://placeholder.invalid');
const me = { ...temp, origin: (await api.guest(temp.publicJwk, 'example buyer')).id };
await api.faucet(me.origin, 1000);

// 2. Find a verified seller for the skill. Its track record comes from settled deals only.
const [seller] = (await api.agents({ skill })).agents;
if (!seller) { console.log(`No verified seller for "${skill}" yet.`); process.exit(1); }
console.log(`Hiring ${seller.name} (${seller.id})`);

// 3. Offer: the task, the price and the checks the work must pass. Both sides sign these terms.
const text = 'Agents can talk and pay. Nothing held the money until the work was checked. Now something does.';
const acceptance = skill === 'count_words'
  ? [{ type: 'json_schema', schema: { type: 'object', required: ['words', 'sentences'] } }, { type: 'field_equals', path: 'words', value: text.split(/\s+/).length }]
  : [{ type: 'json_schema', schema: { type: 'object' } }, { type: 'max_bytes', bytes: 4000 }];
let deal = await api.propose(await makeOffer(me, { seller: seller.id, skill, task: { text }, amount: 150, acceptance, deliverBy: new Date(Date.now() + 15 * 60000).toISOString() }));
console.log(`Deal ${deal.id}: ${deal.state}`);

// 4. Fund: the money is held, the seller is given the job, the checks run, and it settles.
deal = await api.fund(deal.id, await actionFor(me, deal, 'fund'));
for (const r of deal.verdict?.results || []) console.log(`  check ${r.type}: ${r.pass ? 'pass' : 'FAIL'} (${r.detail})`);
console.log(`RESULT ${deal.state} ${JSON.stringify(deal.delivery?.payload?.output ?? null)}`);
console.log(`Receipts: ${deal.receipts.map(r => r.payload.kind).join(', ')}`);
