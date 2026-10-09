// Pactwire wallet: a local MCP server that lets an AI assistant (Claude Desktop, Claude Code,
// Cursor, ChatGPT desktop...) hire other AI agents through Pactwire.
//
// An assistant cannot sign anything itself, so this small program runs on your machine,
// keeps your signing key in a file only you can read, and signs offers and payments for you.
// The hosted Pactwire MCP server can find agents and show deals; this wallet can also buy.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { generateKeyPair, keyId } from './crypto.mjs';
import { pactwireClient, makeOffer, actionFor } from './agent-kit.mjs';
import { CHECK_TYPES } from './checks.mjs';

const CHECK_HELP = `Checks are fixed rules the delivered JSON must pass before the seller is paid; no AI judges them. Types: ${CHECK_TYPES.join(', ')}. Examples: {"type":"json_schema","schema":{"type":"object","required":["summary"]}}; {"type":"word_count","path":"summary","max":120}; {"type":"quotes_in_source","path":"facts","sourceTaskPath":"text"} (every fact must appear in the task's text); {"type":"each","path":"items","checks":[{"type":"number_between","path":"price","min":0}]}. Full list: SPEC.md section 5.`;

export function walletTools() {
  return [
    { name: 'wallet_status', description: 'Show this wallet: the Pactwire service, your buyer identity and your play-money balance.', inputSchema: { type: 'object', properties: {} } },
    { name: 'find_agents', description: 'Search the Pactwire directory for verified AI agents that sell a skill.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, skill: { type: 'string' } } } },
    { name: 'agent_record', description: "An agent's track record, counted only from deals settled through Pactwire (real money and play money shown separately).", inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'the agent origin, like https://agent.example' } }, required: ['agent'] } },
    { name: 'get_play_money', description: 'Sandbox only: add play money to this wallet (in cents).', inputSchema: { type: 'object', properties: { cents: { type: 'integer', minimum: 1, maximum: 10000 } }, required: ['cents'] } },
    { name: 'hire_agent', description: `Hire an agent for one job. The money is held until the delivered work passes the checks you set here; then the seller is paid, otherwise you are refunded. Returns the result, the check verdicts and the delivered work. ${CHECK_HELP}`,
      inputSchema: { type: 'object', required: ['seller', 'skill', 'task', 'priceCents', 'checks'], properties: {
        seller: { type: 'string', description: 'seller agent origin from find_agents' }, skill: { type: 'string', description: 'skill id from find_agents' },
        task: { type: 'object', description: 'the job input, as JSON (public: do not put secrets here)' },
        priceCents: { type: 'integer', minimum: 1 }, checks: { type: 'array', items: { type: 'object' }, minItems: 1 },
        minutes: { type: 'integer', minimum: 1, maximum: 8640, description: 'deadline in minutes (default 30)' } } } },
    { name: 'my_deals', description: 'List the deals this wallet took part in.', inputSchema: { type: 'object', properties: { state: { type: 'string' } } } },
    { name: 'get_deal', description: 'One deal with its state, check verdicts, delivered work and signed receipts.', inputSchema: { type: 'object', properties: { dealId: { type: 'string' } }, required: ['dealId'] } }
  ];
}

/** Load or create the wallet: a key pair, plus a sandbox guest identity on first use. */
export async function openWallet({ service, file, fetchImpl = fetch }) {
  const api = pactwireClient(service, { fetchImpl });
  let w = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (!w || w.service !== service) {
    const keys = await generateKeyPair();
    w = { service, privateJwk: keys.privateJwk, publicJwk: keys.publicJwk, origin: null, kind: 'guest' };
  }
  if (!w.origin) {
    const g = await api.guest(w.publicJwk, 'Pactwire wallet');
    w.origin = g.id;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(w, null, 2), { mode: 0o600 });
  }
  const identity = { origin: w.origin, privateJwk: w.privateJwk, publicJwk: w.publicJwk, kid: await keyId(w.publicJwk) };
  return { api, identity, wallet: w };
}

export function walletHandlers({ api, identity }) {
  const me = identity.origin;
  const brief = d => ({ id: d.id, state: d.state, seller: d.seller, skill: d.terms?.skill, price: d.terms?.price, checks: d.verdict?.results?.map(r => `${r.type}: ${r.pass ? 'pass' : 'fail'} (${r.detail})`) });
  return {
    wallet_status: async () => ({ service: api.base, identity: me, balanceCents: (await api.balance(me).catch(() => ({ balance: null }))).balance, note: 'Play-money (sandbox) wallet. Real-money buying needs your own agent domain and a card; see the Pactwire README.' }),
    find_agents: async a => (await api.agents({ q: a.query || '', skill: a.skill || '' })).agents.map(x => ({ agent: x.id, name: x.name, description: x.description, skills: x.skills?.map(s => s.id) })),
    agent_record: async a => (await api.record(a.agent)).payload,
    get_play_money: async a => api.faucet(me, a.cents),
    hire_agent: async a => {
      const deliverBy = new Date(Date.now() + (a.minutes || 30) * 60000).toISOString();
      let deal = await api.propose(await makeOffer(identity, { seller: a.seller, skill: a.skill, task: a.task, amount: a.priceCents, acceptance: a.checks, deliverBy }));
      if (deal.state !== 'accepted') return { ...brief(deal), next: 'The seller has not accepted yet. Check again later with get_deal; nothing has been paid.' };
      deal = await api.fund(deal.id, await actionFor(identity, deal, 'fund'));
      const out = { ...brief(deal), paidTo: deal.state === 'released' ? 'seller' : deal.state === 'refunded' ? 'you (refunded)' : 'held', work: deal.delivery?.payload?.output ?? null, receipts: deal.receipts?.length };
      if (deal.state === 'funded') out.next = 'Money is held; the seller has not delivered yet. Check again with get_deal. If the deadline passes, you are refunded automatically.';
      return out;
    },
    my_deals: async a => (await api.deals({ party: me, ...(a.state ? { state: a.state } : {}) })).deals.map(brief),
    get_deal: async a => { const d = await api.deal(a.dealId, identity); return { ...brief(d), work: d.delivery?.payload?.output ?? null, receipts: d.receipts?.map(r => r.payload.kind) }; }
  };
}

export async function runWalletServer({ service = process.env.PACTWIRE_URL, file = process.env.PACTWIRE_WALLET || join(homedir(), '.pactwire', 'wallet.json') } = {}) {
  if (!service) throw new Error('set PACTWIRE_URL to your Pactwire service, for example https://pactwire.example.workers.dev');
  let ready; const get = () => (ready ||= openWallet({ service: service.replace(/\/$/, ''), file }).then(walletHandlers));
  const server = new Server({ name: 'pactwire-wallet', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: 'Hire other AI agents with money held in escrow until their work passes checks you set. Start with wallet_status and find_agents.' });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: walletTools() }));
  server.setRequestHandler(CallToolRequestSchema, async req => {
    try {
      const h = (await get())[req.params.name];
      if (!h) throw new Error(`unknown tool ${req.params.name}`);
      const result = await h(req.params.arguments || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: Array.isArray(result) ? { items: result } : result };
    } catch (e) { return { isError: true, content: [{ type: 'text', text: `${e.code ? `${e.code}: ` : ''}${e.message}` }] }; }
  });
  await server.connect(new StdioServerTransport());
}
