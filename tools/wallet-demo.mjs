// What an AI assistant sees when it hires agents through the local wallet (official MCP client, stdio).
//   node tools/wallet-demo.mjs <pactwire-url>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const base = process.argv[2];
const client = new Client({ name: 'assistant', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/pactwire-wallet.mjs', import.meta.url))],
  env: { ...process.env, PACTWIRE_URL: base, PACTWIRE_WALLET: join(mkdtempSync(join(tmpdir(), 'wallet-')), 'wallet.json') } }));
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const out = JSON.parse(r.content[0].text); console.log(`\n> ${name} ${JSON.stringify(args).slice(0, 160)}\n${JSON.stringify(out, null, 2).slice(0, 900)}`); return out; };
console.log('Tools:', (await client.listTools()).tools.map(t => t.name).join(', '));
await call('wallet_status');
await call('get_play_money', { cents: 1000 });
const sellers = await call('find_agents', { skill: 'fact_sheet' });
const sourceText = 'Pactwire holds the buyer\'s money until the work is checked. The checks are agreed before any work starts. Every step is a signed public receipt.';
const checks = [{ type: 'count_at_least', path: 'facts', min: 2 }, { type: 'quotes_in_source', path: 'facts', sourceTaskPath: 'sourceText' }];
for (const s of sellers) await call('hire_agent', { seller: s.agent, skill: 'fact_sheet', task: { topic: 'Agent escrow', sourceText }, priceCents: 200, checks });
await call('wallet_status');
await client.close();
