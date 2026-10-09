// Connection doctor: does an agent's AI-to-AI front door actually open?
// It uses the OFFICIAL A2A and MCP client libraries, so a pass means a real
// third-party agent can connect, not just that our own code agrees with itself.
import { ClientFactory } from '@a2a-js/sdk/client';
import { Role } from '@a2a-js/sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const A2A_CARD_PATH = '/.well-known/agent-card.json';

async function step(name, fn) {
  const started = Date.now();
  try { const detail = await fn(); return { name, ok: true, ms: Date.now() - started, detail }; }
  catch (error) { return { name, ok: false, ms: Date.now() - started, error: String(error?.message || error).slice(0, 400) }; }
}

export async function checkA2A(baseUrl, { probeText = 'What can you do? Please list your skills.', fetchImpl = fetch } = {}) {
  const steps = [];
  let card;
  steps.push(await step('a2a.card.fetch', async () => {
    const r = await fetchImpl(new URL(A2A_CARD_PATH, baseUrl));
    if (!r.ok) throw new Error(`HTTP ${r.status} at ${A2A_CARD_PATH}`);
    const type = r.headers.get('content-type') || '';
    if (!/json/i.test(type)) throw new Error(`card is not JSON (content-type: ${type || 'none'})`);
    card = await r.json();
    return { name: card.name, version: card.version };
  }));
  if (!card) return { ok: false, steps };
  steps.push(await step('a2a.card.spec', async () => {
    const problems = [];
    for (const k of ['name', 'description', 'version', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']) if (card[k] === undefined) problems.push(`missing ${k}`);
    const ifaces = card.supportedInterfaces;
    if (!Array.isArray(ifaces) || !ifaces.length) problems.push('missing supportedInterfaces (A2A 1.0): a client cannot tell where or how to talk to this agent');
    else for (const i of ifaces) { if (!i.url || !i.protocolBinding || !i.protocolVersion) problems.push(`interface incomplete: ${JSON.stringify(i)}`); }
    for (const s of card.skills || []) if (!Array.isArray(s.tags)) problems.push(`skill ${s.id} has no tags`);
    if (problems.length) throw new Error(problems.join('; '));
    return { interfaces: ifaces.map(i => `${i.protocolBinding} ${i.protocolVersion} ${i.url}`), skills: card.skills.map(s => s.id) };
  }));
  let client;
  steps.push(await step('a2a.client.connect (official SDK)', async () => {
    client = await new ClientFactory().createFromUrl(baseUrl);
    return { transport: client?.transport?.constructor?.name || 'connected' };
  }));
  if (client) {
    steps.push(await step('a2a.message.send (official SDK)', async () => {
      const result = await client.sendMessage({
        message: { messageId: crypto.randomUUID(), role: Role.ROLE_USER, parts: [{ content: { $case: 'text', value: probeText } }], contextId: '', taskId: '', metadata: undefined, extensions: [], referenceTaskIds: [] },
        tenant: '', configuration: undefined, metadata: undefined
      });
      const kind = result?.payload?.$case || Object.keys(result || {})[0];
      return { replyKind: kind, reply: JSON.stringify(result).slice(0, 300) };
    }));
  }
  return { ok: steps.every(s => s.ok), steps, card };
}

export async function checkMCP(mcpUrl, { headers = {} } = {}) {
  const steps = [];
  const client = new McpClient({ name: 'agent-pactwire-doctor', version: '0.1.0' });
  let connected = false;
  steps.push(await step('mcp.initialize (official SDK)', async () => {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers } }));
    connected = true;
    return client.getServerVersion();
  }));
  if (connected) {
    steps.push(await step('mcp.tools/list', async () => {
      const { tools } = await client.listTools();
      if (!tools.length) throw new Error('no tools listed');
      return { tools: tools.map(t => t.name) };
    }));
    await client.close().catch(() => {});
  }
  return { ok: steps.every(s => s.ok), steps };
}

export function summarize(report) {
  return report.steps.map(s => `${s.ok ? 'PASS' : 'FAIL'}  ${s.name}${s.ok ? '' : ' -> ' + s.error}`).join('\n');
}
