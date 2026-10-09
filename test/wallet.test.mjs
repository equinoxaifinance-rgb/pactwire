// The wallet MCP server, driven exactly as Claude Desktop or Cursor would: the official MCP
// client starts it as a local process over stdio and calls its tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bootPactwire, bootAgent } from './helpers.mjs';
import { pactwireClient } from '../src/agent-kit.mjs';

test('an AI assistant hires agents through the local wallet over MCP', async t => {
  const hs = await bootPactwire();
  const skills = [{ id: 'facts', name: 'Fact lists', description: 'Lists facts from a text', tags: ['research'] }];
  const honest = await bootAgent({ name: 'Careful Researcher', skills, work: async task => ({ facts: task.text.split('. ').map(s => s.replace(/\.$/, '')) }) });
  const sloppy = await bootAgent({ name: 'Sloppy Researcher', skills, work: async () => ({ facts: ['Escrow was invented in 2025 by robots'] }) });
  const api = pactwireClient(hs.base);
  for (const a of [honest, sloppy]) await api.register(a.origin);
  const file = join(mkdtempSync(join(tmpdir(), 'wallet-')), 'wallet.json');
  const client = new Client({ name: 'assistant', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/pactwire-wallet.mjs', import.meta.url))], env: { ...process.env, PACTWIRE_URL: hs.base, PACTWIRE_WALLET: file } }));
  t.after(() => Promise.all([client.close(), hs.close(), honest.close(), sloppy.close()]));
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text); };

  assert.deepEqual((await client.listTools()).tools.map(x => x.name), ['wallet_status', 'find_agents', 'agent_record', 'get_play_money', 'hire_agent', 'my_deals', 'get_deal']);
  const status = await call('wallet_status');
  assert.match(status.identity, /^https:\/\/guest-[0-9a-f]{24}\.invalid$/);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600, 'the key file is readable only by its owner');
  await call('get_play_money', { cents: 1000 });
  const found = await call('find_agents', { skill: 'facts' });
  assert.equal(found.length, 2);

  const text = 'Escrow holds money until work is checked. Receipts are signed by the service. The public log can be audited by anyone.';
  const checks = [{ type: 'count_at_least', path: 'facts', min: 2 }, { type: 'quotes_in_source', path: 'facts', sourceTaskPath: 'text' }];
  const good = await call('hire_agent', { seller: honest.origin, skill: 'facts', task: { text }, priceCents: 300, checks });
  assert.equal(good.state, 'released'); assert.equal(good.paidTo, 'seller'); assert.equal(good.work.facts.length, 3);
  const bad = await call('hire_agent', { seller: sloppy.origin, skill: 'facts', task: { text }, priceCents: 300, checks });
  assert.equal(bad.state, 'refunded'); assert.match(bad.checks.join(' '), /quotes_in_source: fail/);
  assert.equal((await call('wallet_status')).balanceCents, 700);
  assert.equal((await call('my_deals')).length, 2);
  assert.equal((await call('get_deal', { dealId: good.id })).work.facts[0], 'Escrow holds money until work is checked');
  const err = await client.callTool({ name: 'hire_agent', arguments: { seller: honest.origin, skill: 'facts', task: {}, priceCents: 300, checks: [{ type: 'made_up' }] } });
  assert.equal(err.isError, true); assert.match(err.content[0].text, /unknown check type/);
});
