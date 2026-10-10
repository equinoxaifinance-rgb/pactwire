// Pactwire HTTP surface: REST API, an A2A agent, an MCP server and plain pages,
// all over the same deal engine. Runs as a Cloudflare Worker or under Node.

import { createPactwire, PactwireError } from './service.mjs';
import { verifyStripeWebhook, RailError } from './rails.mjs';
import { readLog, verifyReceipt, verifyChain } from './receipts.mjs';
import { buildAgentCard, createA2AHandler } from './a2a-lite.mjs';
import { identityExtension, createIdentity, makeOffer, actionFor } from './agent-kit.mjs';
import { sendA2A, canonicalOrigin } from './a2a-client.mjs';
import { CHECK_TYPES } from './checks.mjs';
import { landingPage, llmsText, openApi } from './pages.mjs';
import { createFunnel, refLabel, clientLabel, refererHost } from './funnel.mjs';

const VERSION = '0.1.0';
const MCP_PROTOCOL = '2025-06-18';

export function createApp({ db, service, rails, baseUrl, previousKeys = [], stripeWebhookSecret = '', sandbox = true, allowLocal = false, resolveHost = null, trustProxy = false, fetchImpl = fetch, feeBps = 0, now, rateLimit = { perMinute: 120 } }) {
  const hs = createPactwire({ db, service, rails, allowLocal, resolveHost, fetchImpl, feeBps, now });
  const base = baseUrl.replace(/\/$/, '');
  const funnel = createFunnel(db, { now });
  const ownHost = new URL(base).hostname;
  // Our own practice agents live next to the service (pactwire-*.<same account>.workers.dev): not outside sign-ups.
  const ownSuffix = /^[0-9.]+$|^\[/.test(ownHost) || ownHost.split('.').length < 3 ? '' : `.${ownHost.split('.').slice(1).join('.')}`;
  const outside = origin => { try { const h = new URL(origin).hostname; return !h.endsWith('.invalid') && h !== ownHost && !(ownSuffix && h.endsWith(ownSuffix)); } catch { return false; } };
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization, a2a-version, mcp-protocol-version, mcp-session-id, x-pactwire-read', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': 'mcp-session-id' };
  const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value, null, status === 200 ? 0 : 0), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', ...cors, ...headers } });
  const errorResponse = e => {
    if (e instanceof PactwireError) return json({ error: { code: e.code, message: e.message } }, e.status);
    console.error('pactwire internal error', e?.stack || e);
    return json({ error: { code: 'internal', message: 'Pactwire hit an unexpected error.' } }, 500);
  };
  const body = async request => {
    const raw = await request.text();
    if (raw.length > 400_000) throw new PactwireError('too_large', 'request body is limited to 400 KB', 413);
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new PactwireError('bad_json', 'body must be JSON'); }
  };

  async function limited(request) {
    if (!rateLimit) return false;
    // cf-connecting-ip is set by Cloudflare and cannot be forged there; x-forwarded-for is trusted only behind a known proxy.
    const ip = request.headers.get('cf-connecting-ip') || (trustProxy ? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : '') || 'direct';
    const windowStart = Math.floor(Date.now() / 60000);
    const key = `ip:${ip}`;
    await db.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END, window_start = excluded.window_start').bind(key, windowStart).run();
    const row = await db.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(key).first();
    return (row?.count || 0) > rateLimit.perMinute;
  }

  // ---------- the operations, shared by REST, A2A and MCP ----------
  const ops = {
    find_agents: a => hs.listAgents({ q: a.q || a.query || '', skill: a.skill || '', includeUnverified: !!a.includeUnverified, limit: a.limit || 20 }),
    register_agent: async a => {
      let known = null;
      try { known = await hs.getAgent(canonicalOrigin(String(a.origin || ''), { allowLocal })); } catch { /* registerAgent reports bad origins */ }
      const result = await hs.registerAgent(a.origin);
      if (!known && outside(result.id)) await funnel.count('signup');
      return result;
    },
    agent_record: a => hs.agentRecord(canonicalOrigin(a.agent, { allowLocal })),
    get_deal: a => hs.getDeal(a.dealId, a.readAuth),
    list_deals: a => hs.listDeals({ party: a.party, state: a.state }),
    propose_deal: a => hs.propose(a.offer),
    accept_deal: a => hs.accept(a.dealId, a.acceptance),
    fund_deal: a => hs.fund(a.dealId, a.authorization, a.funding),
    deliver: a => hs.deliver(a.dealId, a.delivery),
    cancel_deal: a => hs.cancel(a.dealId, a.cancellation),
    verify_receipt: async a => verifyReceipt(a.receipt, jwks()),
    ask_agent: async a => {
      const agent = await hs.getAgent(canonicalOrigin(a.agent, { allowLocal }));
      if (!agent?.verified || !agent.a2a) throw new PactwireError('unknown_agent', `${a.agent} is not a verified agent in the Pactwire directory`, 404);
      return { agent: agent.id, reply: await sendA2A(agent.a2a, { text: String(a.message || '').slice(0, 8000), data: a.data }, { allowLocal, fetchImpl, resolveHost }) };
    }
  };

  // Sandbox only: try a whole deal with no keys and no install. Pactwire makes a one-off guest buyer key
  // for this call, gives it play money, and signs the offer and funding for it. Real-money deals never
  // work this way: there, only the buyer's own key can sign.
  if (sandbox && rails.sandbox) {
    ops.sandbox_hire = async (a, ctx = {}) => {
      await funnel.count(ctx.self ? 'self:try' : 'try');
      const amount = Number.parseInt(a.priceCents, 10);
      if (!(amount >= 1 && amount <= 1000)) throw new PactwireError('bad_price', 'priceCents must be 1 to 1000 (play money)');
      const minutes = Math.min(Math.max(Number.parseInt(a.minutes, 10) || 10, 1), 60);
      const temp = await createIdentity('https://placeholder.invalid');
      const guest = await hs.registerGuest(temp.publicJwk, 'Sandbox try-it buyer');
      const me = { ...temp, origin: guest.id };
      await rails.sandbox.credit(me.origin, amount);
      const seller = canonicalOrigin(String(a.seller || ''), { allowLocal });
      let deal = await hs.propose(await makeOffer(me, { seller, skill: a.skill, task: a.task ?? {}, amount, acceptance: a.checks, deliverBy: new Date(Date.now() + minutes * 60000).toISOString() }));
      if (deal.state !== 'accepted') return { dealId: deal.id, state: deal.state, buyer: me.origin, note: 'The seller did not accept automatically, so nothing was paid.' };
      deal = await hs.fund(deal.id, await actionFor(me, deal, 'fund'));
      return {
        dealId: deal.id, state: deal.state, buyer: me.origin, seller: deal.seller,
        paidTo: deal.state === 'released' ? 'seller' : deal.state === 'refunded' ? 'buyer (refunded)' : 'held',
        checks: (deal.verdict?.results || []).map(r => ({ type: r.type, pass: r.pass, detail: r.detail })),
        work: deal.delivery?.payload?.output ?? null,
        receipts: deal.receipts.map(r => ({ seq: r.payload.seq, kind: r.payload.kind })),
        verify: `${base}/v1/deals/${deal.id}`, note: 'Play money. The receipts are signed and public; anyone can audit them.'
      };
    };
  }

  // ---------- A2A: Pactwire is itself an agent ----------
  const SKILLS = [
    { id: 'find_agents', name: 'Find verified agents', description: 'Search the directory of agents whose A2A front door and signing key were checked live. Data: { op: "find_agents", q, skill }.', tags: ['discovery', 'directory'] },
    { id: 'deals', name: 'Escrowed deals', description: 'Propose, accept, fund, deliver and settle a job between two agents. Money is held until the delivered work passes the agreed checks. Data: { op: "propose_deal" | "accept_deal" | "fund_deal" | "deliver" | "cancel_deal" | "get_deal", ... }.', tags: ['escrow', 'payments', 'agent-commerce'] },
    { id: 'records', name: 'Verifiable track records', description: 'Signed track record for an agent, counted only from real settled deals. Data: { op: "agent_record", agent }.', tags: ['reputation', 'receipts'] },
    ...(ops.sandbox_hire ? [{ id: 'try_hire', name: 'Try a deal with play money', description: 'Sandbox only. Hire a verified agent with play money and no keys: Pactwire signs for a one-off guest buyer, holds the money, checks the work and settles. Data: { op: "sandbox_hire", seller, skill, task, priceCents (1-1000), checks, minutes (1-60) }. Also POST /v1/sandbox/hire.', tags: ['sandbox', 'try-it', 'escrow'] }] : [])
  ];
  const card = () => {
    const c = buildAgentCard({ name: 'Pactwire', description: 'Escrow and proof for jobs between AI agents. Agents agree terms, the buyer\'s money is held, the work is checked against rules both sides signed, and only then is the seller paid or the buyer refunded. Every step is a signed public receipt.', version: VERSION, baseUrl: base, documentationUrl: `${base}/llms.txt`, skills: SKILLS, provider: { organization: 'Pactwire', url: base } });
    c.capabilities.extensions = [identityExtension({ publicJwk: service.publicJwk, kid: service.kid })];
    return c;
  };
  const a2a = createA2AHandler({
    card, cors,
    async handle({ text, data }) {
      if (data?.pactwire === 'ping') return { text: 'pong', data: { pactwire: 'pong', agent: service.id } };
      const op = data?.op;
      if (op && ops[op] && op !== 'register_agent') {
        try { const result = await ops[op](data); return { text: `${op}: ok`, data: { op, ok: true, result } }; }
        catch (e) { return { text: `${op}: ${e.message}`, data: { op, ok: false, error: { code: e.code || 'error', message: e.message } } }; }
      }
      if (op === 'register_agent') {
        try { return { text: 'registered', data: { op, ok: true, result: await ops.register_agent(data) } }; }
        catch (e) { return { text: e.message, data: { op, ok: false, error: { code: e.code || 'error', message: e.message } } }; }
      }
      const q = (text || '').trim();
      if (q) {
        const found = await hs.listAgents({ q: q.split(/\s+/).filter(w => w.length > 3).slice(0, 1)[0] || '', limit: 5 });
        return { text: `Pactwire holds payment for agent jobs until the work passes agreed checks. Send a data part with "op" (${Object.keys(ops).join(', ')}). ${found.length ? `Verified agents that may match: ${found.map(f => f.name).join(', ')}.` : ''}`, data: { ops: Object.keys(ops), docs: `${base}/llms.txt`, matches: found.map(f => ({ id: f.id, name: f.name })) } };
      }
      return { text: 'Send a data part with an "op".', data: { ops: Object.keys(ops) } };
    }
  });

  // ---------- MCP: Pactwire as tools for Claude, ChatGPT, Cursor and other MCP clients ----------
  const signedObj = { type: 'object', description: 'A signed object { payload, signer, sig } made with the agent kit.', properties: { payload: { type: 'object' }, signer: { type: 'string' }, sig: { type: 'string' } }, required: ['payload', 'signer', 'sig'] };
  const TOOLS = [
    { name: 'pactwire_find_agents', op: 'find_agents', description: 'Search the Pactwire directory for agents whose A2A connection and signing key were verified live. Returns each agent with its track record from real settled deals.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to match in name, description or skills.' }, skill: { type: 'string', description: 'Exact skill id or tag.' } } }, annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: 'pactwire_ask_agent', op: 'ask_agent', description: 'Send a message to a verified A2A agent in the directory and return its reply. This lets MCP clients talk to A2A agents.', inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'Agent origin, e.g. https://agent.example' }, message: { type: 'string' }, data: { type: 'object' } }, required: ['agent', 'message'] }, annotations: { readOnlyHint: false, openWorldHint: true } },
    { name: 'pactwire_agent_record', op: 'agent_record', description: 'Signed track record of an agent: how many paid deals it settled, how many passed the agreed checks, how many distinct paying counterparties.', inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] }, annotations: { readOnlyHint: true } },
    { name: 'pactwire_get_deal', op: 'get_deal', description: 'Get a deal with its state, terms, check results and every signed receipt. The delivered output is shown only with readAuth: a signed { action: "read", dealId, at } from the buyer or seller.', inputSchema: { type: 'object', properties: { dealId: { type: 'string' }, readAuth: { type: 'object', description: 'Optional signed read authorization from the buyer or seller' } }, required: ['dealId'] }, annotations: { readOnlyHint: true } },
    { name: 'pactwire_propose_deal', op: 'propose_deal', description: 'Propose a job to a seller agent. The offer is the buyer agent\'s signed terms (task, price, acceptance checks, deadline, payment rail).', inputSchema: { type: 'object', properties: { offer: signedObj }, required: ['offer'] } },
    { name: 'pactwire_accept_deal', op: 'accept_deal', description: 'Seller accepts a proposed deal with a signed acceptance of the exact terms hash.', inputSchema: { type: 'object', properties: { dealId: { type: 'string' }, acceptance: signedObj }, required: ['dealId', 'acceptance'] } },
    { name: 'pactwire_fund_deal', op: 'fund_deal', description: 'Buyer funds an accepted deal. The money is held, not paid, until the work passes the checks.', inputSchema: { type: 'object', properties: { dealId: { type: 'string' }, authorization: signedObj, funding: { type: 'object', description: 'Rail details, e.g. { payment_method: "pm_..." } for Stripe. Not needed for the sandbox rail.' } }, required: ['dealId', 'authorization'] } },
    { name: 'pactwire_deliver', op: 'deliver', description: 'Seller delivers the work. Pactwire runs the agreed checks at once and pays the seller or refunds the buyer.', inputSchema: { type: 'object', properties: { dealId: { type: 'string' }, delivery: signedObj }, required: ['dealId', 'delivery'] } },
    ...(ops.sandbox_hire ? [{ name: 'pactwire_try_hire', op: 'sandbox_hire', description: 'Try a complete deal with play money, with no keys or install: hire a verified agent, hold the money, check the delivered work against your rules, then pay the seller or refund. Returns the verdicts, the work (if paid for) and the public signed receipts. Rules are deterministic checks such as {"type":"json_schema","schema":{...}}, {"type":"quotes_in_source","path":"facts","sourceTaskPath":"sourceText"}, {"type":"count_at_least","path":"facts","min":3}. Sandbox only.', inputSchema: { type: 'object', properties: { seller: { type: 'string', description: 'seller agent origin from pactwire_find_agents' }, skill: { type: 'string' }, task: { type: 'object', description: 'the job input (public)' }, priceCents: { type: 'integer', minimum: 1, maximum: 1000 }, checks: { type: 'array', items: { type: 'object' }, minItems: 1 }, minutes: { type: 'integer', minimum: 1, maximum: 60 } }, required: ['seller', 'skill', 'task', 'priceCents', 'checks'] }, annotations: { readOnlyHint: false, openWorldHint: true } }] : []),
    { name: 'pactwire_verify_receipt', op: 'verify_receipt', description: 'Check that a Pactwire receipt is genuine and unaltered.', inputSchema: { type: 'object', properties: { receipt: { type: 'object' } }, required: ['receipt'] }, annotations: { readOnlyHint: true } }
  ];
  async function mcp(request) {
    if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed', message: 'MCP uses POST (Streamable HTTP, JSON responses).' } }, 405, { allow: 'POST, OPTIONS' });
    let rpc;
    try { rpc = await body(request); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
    const id = rpc?.id ?? null;
    const ok = (result, headers = {}) => json({ jsonrpc: '2.0', id, result }, 200, headers);
    // The session id carries only the client's self-declared name (e.g. "claude-ai", "cursor") plus a random tag,
    // so later tools/list and tools/call requests can be counted per client without storing anything per user.
    const client = /^pw1\.([a-z0-9-]{1,32})\.[0-9a-f]{16}$/.exec(request.headers.get('mcp-session-id') || '')?.[1] || 'unknown';
    const err = (code, message) => json({ jsonrpc: '2.0', id, error: { code, message } });
    if (rpc?.method === 'initialize') {
      const name = clientLabel(rpc.params?.clientInfo?.name);
      await funnel.count(`mcp_init:${name}`);
      const tag = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
      return ok({ protocolVersion: rpc.params?.protocolVersion === '2025-03-26' ? '2025-03-26' : MCP_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'pactwire', title: 'Pactwire', version: VERSION }, instructions: 'Pactwire holds payment for jobs between AI agents until the delivered work passes checks both sides signed. Start with pactwire_find_agents. ' + (ops.sandbox_hire ? 'To try a whole deal with play money and no setup, use pactwire_try_hire. ' : '') + 'Real deals are signed by the buyer agent itself (agent kit or the local wallet); see ' + `${base}/llms.txt` }, { 'mcp-session-id': `pw1.${name}.${tag}` });
    }
    if (typeof rpc?.method === 'string' && rpc.method.startsWith('notifications/') && !Object.hasOwn(rpc, 'id')) return new Response(null, { status: 202, headers: cors });
    if (rpc?.method === 'ping') return ok({});
    if (rpc?.method === 'tools/list') { await funnel.count(`mcp_list:${client}`); return ok({ tools: TOOLS.map(({ op, ...t }) => t) }); }
    if (rpc?.method === 'tools/call') {
      const tool = TOOLS.find(t => t.name === rpc.params?.name);
      if (!tool) return err(-32602, `Unknown tool: ${String(rpc.params?.name).slice(0, 80)}`);
      await funnel.count(`mcp_call:${client}`, `tool:${tool.name}`);
      try {
        const args = rpc.params.arguments || {};
        const result = await ops[tool.op](tool.op === 'find_agents' ? { q: args.query, skill: args.skill } : args);
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2).slice(0, 100_000) }], structuredContent: Array.isArray(result) ? { items: result } : result, isError: false });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: `${e.code || 'error'}: ${e.message}` }], isError: true });
      }
    }
    return err(-32601, 'Method not found');
  }

  // Current key first, then retired keys, so receipts signed before a rotation still verify.
  const jwks = () => ({ keys: [{ ...service.publicJwk, kid: service.kid, use: 'sig', alg: 'EdDSA' }, ...previousKeys.map(k => ({ kty: 'OKP', crv: 'Ed25519', x: k.x, kid: k.kid, use: 'sig', alg: 'EdDSA', status: 'retired' }))] });

  // ---------- routing ----------
  async function route(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    if (m === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (m === 'POST' && await limited(request)) return json({ error: { code: 'rate_limited', message: 'Too many requests; slow down.' } }, 429, { 'retry-after': '60' });
    if (m === 'GET' && (p === '/' || p === '/llms.txt' || p === '/.well-known/agent-card.json' || p === '/.well-known/agent.json')) {
      const ref = url.searchParams.get('ref');
      if (ref === 'live-check') await funnel.count('self:land');
      else {
        const host = refererHost(request.headers.get('referer'), ownHost);
        await funnel.count('land', ...(ref ? [`ref:${refLabel(ref)}`] : []), ...(host ? [`referer:${host}`] : []));
      }
    }
    if (m === 'GET' && p === '/v1/funnel') return json(await funnel.read());
    if (a2a.match(request)) return a2a.fetch(request);
    if (p === '/mcp') return mcp(request);
    if (m === 'GET' && p === '/') return new Response(landingPage(base, sandbox), { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" } });
    if (m === 'GET' && p === '/llms.txt') return new Response(llmsText(base, sandbox, CHECK_TYPES), { headers: { 'content-type': 'text/plain; charset=utf-8', ...cors } });
    if (m === 'GET' && p === '/openapi.json') return json(openApi(base, VERSION, !!ops.sandbox_hire));
    if (m === 'GET' && p === '/health') return json({ ok: true, version: VERSION, sandbox });
    if (m === 'GET' && p === '/.well-known/jwks.json') return json(jwks());
    if (m === 'GET' && p === '/.well-known/pactwire.json') return json({ service: service.id, version: VERSION, termsVersion: 'pactwire/1', identityExtension: 'urn:pactwire:identity:1', rails: Object.keys(rails), checks: CHECK_TYPES, sandbox, mcp: `${base}/mcp`, a2a: `${base}/.well-known/agent-card.json`, log: `${base}/v1/log`, jwks: `${base}/.well-known/jwks.json`, feeBps });

    if (p === '/v1/agents' && m === 'POST') return json(await ops.register_agent(await body(request)), 201);
    if (p === '/v1/agents' && m === 'GET') return json({ agents: await ops.find_agents({ q: url.searchParams.get('q') || '', skill: url.searchParams.get('skill') || '', includeUnverified: url.searchParams.get('all') === '1' }) });
    if (p === '/v1/agents/record' && m === 'GET') return json(await ops.agent_record({ agent: url.searchParams.get('agent') }));
    if (p === '/v1/deals' && m === 'POST') return json(await ops.propose_deal(await body(request)), 201);
    if (p === '/v1/deals' && m === 'GET') return json({ deals: await ops.list_deals({ party: url.searchParams.get('party'), state: url.searchParams.get('state') }) });
    const dm = p.match(/^\/v1\/deals\/(deal_[A-Za-z0-9]{24})(?:\/(accept|fund|deliver|cancel))?$/);
    if (dm) {
      const [, dealId, action] = dm;
      if (!action && m === 'GET') {
        const h = request.headers.get('x-pactwire-read');
        let readAuth;
        if (h) { try { readAuth = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(h.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))); } catch { throw new PactwireError('bad_read', 'x-pactwire-read must be base64url JSON of a signed read authorization'); } }
        return json(await ops.get_deal({ dealId, readAuth }));
      }
      if (action && m === 'POST') {
        const b = await body(request);
        const op = { accept: 'accept_deal', fund: 'fund_deal', deliver: 'deliver', cancel: 'cancel_deal' }[action];
        return json(await ops[op]({ ...b, dealId }));
      }
    }
    if (p === '/v1/stripe/webhook' && m === 'POST') {
      if (!stripeWebhookSecret) return json({ error: { code: 'not_configured', message: 'Stripe webhooks are not configured.' } }, 404);
      let event;
      try { event = await verifyStripeWebhook(await request.text(), request.headers.get('stripe-signature'), stripeWebhookSecret); }
      catch (e) { return json({ error: { code: 'bad_signature', message: e instanceof RailError ? e.message : 'invalid webhook' } }, 400); }
      if (/^charge\.dispute\./.test(event.type || '')) {
        const d = event.data?.object || {};
        const pi = typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent?.id;
        if (pi) await hs.recordDispute(pi, d.status || event.type, d.id);
      }
      return json({ received: true });
    }
    if (p === '/v1/log' && m === 'GET') return json({ receipts: await readLog(db, { after: Number(url.searchParams.get('after') || 0), limit: Number(url.searchParams.get('limit') || 100) }) });
    if (p === '/v1/verify' && m === 'POST') {
      const b = await body(request);
      if (Array.isArray(b.receipts)) return json(await verifyChain(b.receipts, jwks()));
      return json(await verifyReceipt(b.receipt, jwks()));
    }
    if (sandbox && rails.sandbox && p === '/v1/sandbox/faucet' && m === 'POST') {
      const b = await body(request);
      const agent = await hs.getAgent(String(b.agent || ''));
      if (!agent) throw new PactwireError('unknown_agent', 'register the agent first', 404);
      const amount = Math.min(Math.max(Number.parseInt(b.amount, 10) || 1000, 1), 100_00);
      return json({ agent: agent.id, balance: await rails.sandbox.credit(agent.id, amount), note: 'Sandbox credits are play money.' });
    }
    if (ops.sandbox_hire && p === '/v1/sandbox/hire' && m === 'POST') return json(await ops.sandbox_hire(await body(request), { self: url.searchParams.get('ref') === 'live-check' }));
    if (sandbox && rails.sandbox && p === '/v1/sandbox/guest' && m === 'POST') { const b = await body(request); return json(await hs.registerGuest(b.publicJwk, b.name), 201); }
    if (sandbox && rails.sandbox && p === '/v1/sandbox/balance' && m === 'GET') return json({ agent: url.searchParams.get('agent'), balance: await rails.sandbox.balance(url.searchParams.get('agent') || '') });
    return json({ error: { code: 'not_found', message: 'Unknown route. See /llms.txt or /openapi.json.' } }, 404);
  }

  return {
    hs,
    async fetch(request) {
      try { return await route(request); } catch (e) { return errorResponse(e); }
    },
    async scheduled() {
      await db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Math.floor(Date.now() / 60000) - 2).run();
      return hs.sweep();
    }
  };
}
