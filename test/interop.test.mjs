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
