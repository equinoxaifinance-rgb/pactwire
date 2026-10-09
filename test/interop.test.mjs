// Interoperability with the OFFICIAL A2A and MCP client libraries (not our own code).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientFactory, JsonRpcTransportFactory, RestTransportFactory } from '@a2a-js/sdk/client';
import { Role } from '@a2a-js/sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bootPactwire, bootAgent } from './helpers.mjs';
import { checkA2A, checkMCP } from '../src/doctor.mjs';
import { pactwireClient } from '../src/agent-kit.mjs';
import { verifyChain } from '../src/receipts.mjs';

const msg = parts => ({ messageId: crypto.randomUUID(), role: Role.ROLE_USER, parts, contextId: '', taskId: '', metadata: undefined, extensions: [], referenceTaskIds: [] });
const dataPart = value => ({ content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: '' });
const textPart = value => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: '' });
const req = message => ({ message, tenant: '', configuration: undefined, metadata: undefined });

test('official A2A SDK connects to Pactwire and to kit-built agents over both bindings', async t => {
  const hs = await bootPactwire();
  const seller = await bootAgent({ name: 'Kit Seller', skills: [{ id: 'echo', name: 'Echo', description: 'echo' }], work: async x => x });
  t.after(() => Promise.all([hs.close(), seller.close()]));
  for (const base of [hs.base, seller.origin]) {
    const report = await checkA2A(base);
    assert.equal(report.ok, true, JSON.stringify(report.steps.filter(s => !s.ok)));
  }
  await pactwireClient(hs.base).register(seller.origin);
  for (const factory of [new RestTransportFactory(), new JsonRpcTransportFactory()]) {
    const client = await new ClientFactory({ transports: [factory] }).createFromUrl(hs.base);
    const reply = await client.sendMessage(req(msg([dataPart({ op: 'find_agents', q: 'echo' })])));
    const data = reply.parts.find(p => p.content?.$case === 'data').content.value;
    assert.equal(data.ok, true);
    assert.equal(data.result[0].id, seller.origin, factory.constructor.name);
    const help = await client.sendMessage(req(msg([textPart('what is this?')])));
    assert.match(help.parts[0].content.value, /Pactwire holds payment/);
  }
});

test('official MCP SDK lists Pactwire tools and reaches an A2A agent through the bridge', async t => {
  const hs = await bootPactwire();
  const seller = await bootAgent({ name: 'Bridge Target', skills: [{ id: 'echo', name: 'Echo', description: 'echo' }] });
  t.after(() => Promise.all([hs.close(), seller.close()]));
  await pactwireClient(hs.base).register(seller.origin);
  const report = await checkMCP(`${hs.base}/mcp`);
  assert.equal(report.ok, true, JSON.stringify(report.steps));
  const client = new McpClient({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${hs.base}/mcp`)));
  const { tools } = await client.listTools();
  assert.ok(tools.some(t => t.name === 'pactwire_propose_deal'));
  const found = await client.callTool({ name: 'pactwire_find_agents', arguments: { query: 'bridge' } });
  assert.equal(found.isError, false);
  assert.equal(found.structuredContent.items[0].id, seller.origin);
  const asked = await client.callTool({ name: 'pactwire_ask_agent', arguments: { agent: seller.origin, message: 'hello from an MCP client' } });
  assert.equal(asked.isError, false, asked.content[0].text);
  assert.match(asked.structuredContent.reply.text, /I am Bridge Target/);
  const unknown = await client.callTool({ name: 'pactwire_ask_agent', arguments: { agent: 'http://127.0.0.1:1', message: 'x' } });
  assert.equal(unknown.isError, true);
  await client.close();
});

test('any MCP client can try a whole play-money deal with no keys or install', async t => {
  const hs = await bootPactwire();
  const skills = [{ id: 'facts', name: 'Facts', description: 'Lists facts from a text', tags: ['research'] }];
  const honest = await bootAgent({ name: 'Honest Facts', skills, work: async task => ({ facts: task.text.split('. ').map(s => s.replace(/\.$/, '')) }) });
  const sloppy = await bootAgent({ name: 'Sloppy Facts', skills, work: async () => ({ facts: ['Something nobody said at all'] }) });
  t.after(() => Promise.all([hs.close(), honest.close(), sloppy.close()]));
  for (const a of [honest, sloppy]) await pactwireClient(hs.base).register(a.origin);
  const client = new McpClient({ name: 'chat-assistant', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${hs.base}/mcp`)));
  t.after(() => client.close());
  assert.ok((await client.listTools()).tools.some(x => x.name === 'pactwire_try_hire'));
  // The REST contract and the A2A card advertise it too, so agents that never read llms.txt can find it.
  assert.ok((await (await fetch(`${hs.base}/openapi.json`)).json()).paths['/v1/sandbox/hire']);
  assert.ok((await (await fetch(`${hs.base}/.well-known/agent-card.json`)).json()).skills.some(x => x.id === 'try_hire'));
  const text = 'Escrow holds the money until the work is checked. Receipts are signed by the service. Anyone can audit the log.';
  const checks = [{ type: 'count_at_least', path: 'facts', min: 2 }, { type: 'quotes_in_source', path: 'facts', sourceTaskPath: 'text' }];
  const good = await client.callTool({ name: 'pactwire_try_hire', arguments: { seller: honest.origin, skill: 'facts', task: { text }, priceCents: 150, checks } });
  assert.equal(good.isError, false, good.content[0].text);
  assert.equal(good.structuredContent.state, 'released');
  assert.equal(good.structuredContent.work.facts.length, 3);
  assert.equal(good.structuredContent.receipts.at(-1).kind, 'deal.released');
  const bad = await client.callTool({ name: 'pactwire_try_hire', arguments: { seller: sloppy.origin, skill: 'facts', task: { text }, priceCents: 150, checks } });
  assert.equal(bad.structuredContent.state, 'refunded');
  assert.equal(bad.structuredContent.work, null, 'a refunded buyer does not get the work');
  const tooMuch = await client.callTool({ name: 'pactwire_try_hire', arguments: { seller: honest.origin, skill: 'facts', task: { text }, priceCents: 5000, checks } });
  assert.equal(tooMuch.isError, true);
  // Every receipt it produced is in the public log and verifies.
  const api = pactwireClient(hs.base);
  assert.equal((await verifyChain((await api.log(0)).receipts, await api.jwks())).ok, true);
});
