// Checks the Vercel AI SDK snippet in docs/FRAMEWORKS.md: connect, list tools, call one tool
// with no LLM. With --hire, runs a whole play-money deal against the live practice agents.
//   npm install && node check_ai_sdk.mjs https://pactwire.neoaethel.workers.dev --hire
const base = process.argv[2].replace(/\/$/, '');
const hire = process.argv.includes('--hire');

// --- snippet: Vercel AI SDK ---
import { createMCPClient } from '@ai-sdk/mcp';
const pactwire = await createMCPClient({ transport: { type: 'http', url: `${base}/mcp` } });
const tools = await pactwire.tools();
// const result = await generateText({ model, tools, prompt: '...' });
// --- end snippet ---

try {
  const args = hire
    ? { seller: 'https://pactwire-fact-writer.neoaethel.workers.dev', skill: 'fact_sheet', priceCents: 100,
        task: { topic: 'Agent escrow', sourceText: 'Agents can talk and pay. Nothing holds the money until the work is checked. Pactwire holds it and settles by rules both sides signed.' },
        checks: [{ type: 'count_at_least', path: 'facts', min: 3 }, { type: 'quotes_in_source', path: 'facts', sourceTaskPath: 'sourceText' }] }
    : { query: 'fact' };
  const out = await tools[hire ? 'pactwire_try_hire' : 'pactwire_find_agents'].execute(args, { toolCallId: 'check', messages: [] });
  const text = out.content.map(c => c.text).join('');
  const ok = !out.isError && (!hire || text.includes('"released"'));
  console.log(`${ok ? 'PASS' : 'FAIL'}  Vercel AI SDK  ${Object.keys(tools).length} tools; ${hire ? (ok ? 'deal released' : text.slice(0, 200)) : text.slice(0, 120)}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await pactwire.close();
}
