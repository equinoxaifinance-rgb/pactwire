// Funnel counters: aggregate counts only, our own traffic kept apart, and MCP clients counted by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bootPactwire, bootAgent } from './helpers.mjs';
import { pactwireClient } from '../src/agent-kit.mjs';
import { openD1 } from '../src/d1-sqlite.mjs';
import { createFunnel, refLabel, refererHost } from '../src/funnel.mjs';

const today = () => new Date().toISOString().slice(0, 10);

test('landings, tries, sign-ups and MCP clients are counted per day with nothing personal stored', async t => {
  const hs = await bootPactwire();
  const skills = [{ id: 'facts', name: 'Facts', description: 'Lists facts', tags: ['research'] }];
  const seller = await bootAgent({ name: 'Counter Seller', skills, work: async task => ({ facts: task.text.split('. ') }) });
  t.after(() => Promise.all([hs.close(), seller.close()]));

  await fetch(`${hs.base}/?ref=awesome-mcp`, { headers: { referer: 'https://github.com/punkpeye/awesome-mcp-servers' } });
  await fetch(`${hs.base}/llms.txt?ref=Bad%20Ref!`);
  await fetch(`${hs.base}/.well-known/agent-card.json`);
  await fetch(`${hs.base}/llms.txt?ref=live-check`);

  await pactwireClient(hs.base).register(seller.origin);
  await pactwireClient(hs.base).register(seller.origin); // the same agent again is not a new sign-up

  const client = new McpClient({ name: 'Claude AI', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${hs.base}/mcp`));
  await client.connect(transport);
  t.after(() => client.close());
  assert.match(transport.sessionId, /^pw1\.claude-ai\.[0-9a-f]{16}$/);
  await client.listTools();
  const args = { seller: seller.origin, skill: 'facts', task: { text: 'One. Two' }, priceCents: 5, checks: [{ type: 'count_at_least', path: 'facts', min: 2 }] };
  const r = await client.callTool({ name: 'pactwire_try_hire', arguments: args });
  assert.equal(r.structuredContent.state, 'released');
  const self = await (await fetch(`${hs.base}/v1/sandbox/hire?ref=live-check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })).json();
  assert.equal(self.state, 'released');

  const f = await (await fetch(`${hs.base}/v1/funnel`)).json();
  const d = f.days[today()];
  assert.equal(f.product, 'pactwire');
  assert.equal(d.land, 3);
  assert.deepEqual(d.refs, { 'awesome-mcp': 1, other: 1 });
  assert.deepEqual(d.referers, { 'github.com': 1 });
  assert.equal(d.signup, 0, 'an agent on the service\'s own host is not an outside sign-up');
  assert.equal(d.try, 1);
  assert.deepEqual(d.self, { land: 1, try: 1 });
  assert.deepEqual(d.mcp.initialize, { 'claude-ai': 1 });
  assert.deepEqual(d.mcp.tools_list, { 'claude-ai': 1 });
  assert.deepEqual(d.mcp.tools_call, { 'claude-ai': 1 });
  assert.deepEqual(d.tools, { pactwire_try_hire: 1 });
  // Only integers and short labels: no IPs, user agents or origins anywhere in the answer.
  assert.doesNotMatch(JSON.stringify(f), /127\.0\.0\.1|node|undici|Mozilla/);
});

test('labels are squeezed and capped so the table cannot grow without bound', async () => {
  assert.equal(refLabel('x402-2222'), 'x402-2222');
  assert.equal(refLabel('<script>'), 'other');
  assert.equal(refererHost('https://pactwire.example.dev/x', 'pactwire.example.dev'), '');
  assert.equal(refererHost('not a url', 'h'), '');
  const db = openD1();
  const funnel = createFunnel(db);
  for (let i = 0; i < 80; i++) await funnel.count(`ref:r${i}`);
  const rows = (await db.prepare('SELECT COUNT(*) AS c FROM funnel').first()).c;
  assert.ok(rows <= 51, `${rows} rows`);
  const d = (await funnel.read()).days[today()];
  assert.ok(Object.keys(d.refs).length <= 21);
  assert.ok('other' in d.refs);
  assert.equal(Object.values(d.refs).reduce((a, b) => a + b, 0), 80);
});

test('a new outside agent counts as a sign-up; our own practice agents and repeat registrations do not', async t => {
  const { createApp } = await import('../src/app.mjs');
  const { sandboxRail } = await import('../src/rails.mjs');
  const { generateKeyPair } = await import('../src/crypto.mjs');
  const { loadServiceKey } = await import('../src/service-key.mjs');
  const base = 'https://pactwire.acct.workers.dev';
  const db = openD1();
  const app = createApp({ db, service: await loadServiceKey((await generateKeyPair()).privateJwk, base), rails: { sandbox: sandboxRail(db) }, baseUrl: base, allowLocal: true, rateLimit: null });
  const stranger = await bootAgent({ name: 'Stranger', skills: [{ id: 'x', name: 'X', description: 'x' }] });
  t.after(() => stranger.close());
  const register = origin => app.fetch(new Request(`${base}/v1/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin }) }));
  assert.equal((await register(stranger.origin)).status, 201);
  assert.equal((await register(stranger.origin)).status, 201);
  await register('https://pactwire-fact-writer.acct.workers.dev'); // ours, and unreachable here: never counted
  const d = (await (await app.fetch(new Request(`${base}/v1/funnel`))).json()).days[today()];
  assert.equal(d.signup, 1);
});
