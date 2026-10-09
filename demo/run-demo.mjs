// End-to-end demo: independent agents find each other, agree a paid job, and get paid
// (or not) depending on whether the work passes the checks they both signed.
//
//   node demo/run-demo.mjs                 boots Pactwire in Node
//   node demo/run-demo.mjs http://127.0.0.1:8799   uses a running Pactwire (e.g. `wrangler dev`)
//
// Writes a plain-English transcript to demo/DEMO-OUTPUT.md.
import { writeFileSync } from 'node:fs';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bootPactwire, bootAgent } from '../test/helpers.mjs';
import { startSdkSeller } from './sdk-seller.mjs';
import { freePort } from '../src/serve.mjs';
import { pactwireClient, makeOffer, actionFor } from '../src/agent-kit.mjs';
import { verifyChain } from '../src/receipts.mjs';

const lines = [];
const say = s => { console.log(s); lines.push(s); };
const money = c => `$${(c / 100).toFixed(2)}`;

const external = process.argv[2];
const hs = external ? { base: external.replace(/\/$/, ''), close: async () => {} } : await bootPactwire();
say(`# Pactwire demo\n\nRun at ${new Date().toISOString()} against ${external ? `a running Pactwire at ${hs.base}` : 'Pactwire booted in Node'}.\n`);

const brief = { topic: 'Why agents need escrow', sourceText: 'Agents can talk and pay, but nothing holds money until work is checked. x402 payments are forward-only. Escrow proposals have no maintainer reply. A signed receipt can prove what was delivered.' };
const FACT_CHECKS = [
  { type: 'json_schema', schema: { type: 'object', required: ['title', 'facts'], properties: { title: { type: 'string', minLength: 5, maxLength: 120 }, facts: { type: 'array', minItems: 3, maxItems: 10, items: { type: 'string', minLength: 10, maxLength: 300 } } } } },
  { type: 'contains_text', path: 'title', text: 'escrow' },
  { type: 'max_bytes', bytes: 4000 }
];
const honestWork = async task => ({ title: `Fact sheet: ${task.topic.toLowerCase()}`, facts: task.sourceText.split('. ').map(s => s.replace(/\.$/, '') + '.') });

const buyer = await bootAgent({ name: 'Research Desk (buyer)' });
const sdkPort = await freePort();
const honest = await startSdkSeller({ port: sdkPort, name: 'Fact Sheet Writer', skillId: 'fact_sheet', work: honestWork });
const cutter = await bootAgent({ name: 'Corner Cutter', skills: [{ id: 'fact_sheet', name: 'Fact sheets', description: 'Cheap fact sheets', tags: ['writing'] }], work: async () => ({ title: 'Stuff', facts: ['It is good.'] }) });
const checker = await bootAgent({ name: 'Independent Checker', skills: [{ id: 'verify_facts', name: 'Verify fact sheets', description: 'Checks every fact appears in the source', tags: ['verification'] }],
  verify: async (output) => { const ok = Array.isArray(output.facts) && output.facts.every(f => brief.sourceText.includes(f.replace(/\.$/, ''))); return { verdict: ok ? 'pass' : 'fail', reason: ok ? 'every fact is in the source' : 'a fact is not in the source' }; } });

const api = pactwireClient(hs.base);
say('## 1. Four independent agents join');
say(`- Research Desk (buyer), built with Pactwire's agent kit: ${buyer.origin}`);
say(`- Fact Sheet Writer (seller), built with the official A2A SDK and Express: ${honest.origin}`);
say(`- Corner Cutter (seller that cheats), built with the agent kit: ${cutter.origin}`);
say(`- Independent Checker (verifier), built with the agent kit: ${checker.origin}`);
for (const a of [buyer, honest, cutter, checker]) {
  const r = await api.register(a.origin);
  say(`  - registered ${r.name}: verified=${r.verified} (card read, signing key found, live A2A message answered)`);
}
await api.faucet(buyer.origin, 2000);
say(`- Research Desk gets ${money(2000)} of sandbox credit.\n`);

say('## 2. The buyer finds sellers through MCP (the official MCP client)');
const mcp = new McpClient({ name: 'research-desk', version: '1.0.0' });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${hs.base}/mcp`)));
const found = (await mcp.callTool({ name: 'pactwire_find_agents', arguments: { skill: 'fact_sheet' } })).structuredContent.items;
say(`- pactwire_find_agents(skill: fact_sheet) returned: ${found.map(f => f.name).join(', ')}`);
const hello = (await mcp.callTool({ name: 'pactwire_ask_agent', arguments: { agent: honest.origin, message: 'Hi, what do you do?' } })).structuredContent;
say(`- pactwire_ask_agent bridged an MCP call to the A2A seller. It answered: "${hello.reply.text}"\n`);
await mcp.close();

async function runDeal(label, seller, acceptance, amount) {
  say(`## ${label}`);
  const offer = await makeOffer(buyer.identity, { seller: seller.origin, skill: 'fact_sheet', task: brief, amount, acceptance, deliverBy: new Date(Date.now() + 30 * 60000).toISOString() });
  let deal = await api.propose(offer);
  say(`- Buyer signs an offer for ${money(amount)} with ${acceptance.length} check(s). Deal ${deal.id}.`);
  say(`- Seller was told over A2A and ${deal.state === 'accepted' ? 'signed the same terms (accepted)' : `left it ${deal.state}`}.`);
  deal = await api.fund(deal.id, await actionFor(buyer.identity, deal, 'fund'));
  say(`- Buyer funds it. The money is held, then Pactwire hands the job to the seller over A2A.`);
  for (const r of deal.verdict?.results || []) say(`  - check ${r.type}: ${r.pass ? 'PASS' : 'FAIL'} (${r.detail})`);
  say(`- Result: **${deal.state === 'released' ? `paid to the seller (${money(amount)})` : `refunded to the buyer (${money(amount)})`}**.`);
  say(`- Receipts: ${deal.receipts.map(r => r.payload.kind.replace('deal.', '')).join(' → ')}\n`);
  return deal;
}

await runDeal('3. Honest seller (built on the official A2A SDK)', honest, FACT_CHECKS, 500);
await runDeal('4. Seller that cuts corners', cutter, FACT_CHECKS, 500);
await runDeal('5. Same honest seller, with an independent checker agent as a rule', honest, [...FACT_CHECKS, { type: 'verifier_agent', agent: checker.origin }], 300);

say('## 6. Where the money ended up');
for (const a of [['Research Desk', buyer], ['Fact Sheet Writer', honest], ['Corner Cutter', cutter]]) say(`- ${a[0]}: ${money((await api.balance(a[1].origin)).balance)}`);
say('');
say('## 7. Track records (counted only from settled deals; signed by Pactwire; play money is kept separate from real money)');
for (const a of [['Fact Sheet Writer', honest], ['Corner Cutter', cutter]]) {
  const p = (await api.record(a[1].origin)).payload;
  say(`- ${a[0]}: real money ${p.seller.passed} passed / ${p.seller.failedOrLate} failed; play money ${p.sandbox.seller.passed} passed / ${p.sandbox.seller.failedOrLate} failed, ${p.sandbox.seller.distinctPayingBuyers} distinct buyer(s)`);
}
say('');
say('## 8. Anyone can check the whole log offline');
const pub = await api.jwks();
const { receipts } = await api.log(0);
const chain = await verifyChain(receipts, pub);
say(`- Downloaded ${chain.count} receipts and checked every signature and link with only the public key: ${chain.ok ? 'all valid' : `PROBLEMS: ${chain.problems.join('; ')}`}.`);
const tampered = structuredClone(receipts);
const refund = tampered.find(r => r.payload.kind === 'deal.refunded');
if (refund) { refund.payload.data.paidTo = cutter.origin; say(`- Changing one word in one receipt (who got paid): ${(await verifyChain(tampered, pub)).ok ? 'NOT detected' : 'detected'}.`); }

writeFileSync(new URL('./DEMO-OUTPUT.md', import.meta.url), lines.join('\n') + '\n');
await Promise.all([buyer.close(), honest.close(), cutter.close(), checker.close(), hs.close()]);
console.log('\nTranscript written to demo/DEMO-OUTPUT.md');
