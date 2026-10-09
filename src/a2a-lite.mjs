// a2a-lite: a tiny, dependency-free A2A 1.0 server kit for Cloudflare Workers and Node.
//
// A2A ("Agent2Agent") is the open protocol agents use to talk to each other.
// An agent publishes a card at /.well-known/agent-card.json saying who it is and
// where to send messages; other agents send it messages and get replies.
//
// This kit gives a stateless agent both official wire formats from one handler:
//   - HTTP+JSON:  POST {base}/message:send
//   - JSON-RPC:   POST {base}/a2a   with method "SendMessage"
// It is checked against the official @a2a-js/sdk client in this folder's tests.

export const A2A_PROTOCOL_VERSION = '1.0';
export const A2A_MEDIA_TYPE = 'application/a2a+json';
const MAX_BYTES = 64 * 1024;
const SUPPORTED_VERSIONS = ['1.0', '1.0.0', '1.0.1'];

// JSON-RPC error codes from the A2A 1.0 specification.
export const A2A_ERRORS = Object.freeze({
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  TASK_NOT_FOUND: -32001, TASK_NOT_CANCELABLE: -32002, PUSH_NOT_SUPPORTED: -32003, UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005, VERSION_NOT_SUPPORTED: -32009
});

export class A2AInputError extends Error {
  constructor(message, code = A2A_ERRORS.INVALID_PARAMS, status = 400) { super(message); this.code = code; this.status = status; }
}

/** Build a spec-complete A2A 1.0 agent card. `extra` is merged last (provider, iconUrl, security, ...). */
export function buildAgentCard({ name, description, version, baseUrl, documentationUrl, skills, provider, extra = {} }) {
  const rpcUrl = `${baseUrl.replace(/\/$/, '')}/a2a`;
  return {
    name, description, version,
    ...(documentationUrl ? { documentationUrl } : {}),
    ...(provider ? { provider } : {}),
    supportedInterfaces: [
      { url: baseUrl.replace(/\/$/, ''), protocolBinding: 'HTTP+JSON', protocolVersion: A2A_PROTOCOL_VERSION },
      { url: rpcUrl, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }
    ],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: skills.map(s => ({
      id: s.id, name: s.name, description: s.description,
      tags: s.tags?.length ? s.tags : [s.id],
      ...(s.examples ? { examples: s.examples } : {}),
      inputModes: s.inputModes || ['text/plain', 'application/json'],
      outputModes: s.outputModes || ['text/plain', 'application/json']
    })),
    ...extra
  };
}

/** Pull the plain text and the first JSON data object out of an incoming message. */
export function readMessage(message) {
  if (!message || typeof message !== 'object') throw new A2AInputError('message is required');
  if (message.role !== 'ROLE_USER' && message.role !== 'user') throw new A2AInputError('message.role must be ROLE_USER');
  if (!Array.isArray(message.parts) || !message.parts.length) throw new A2AInputError('message.parts must be a non-empty array');
  if (message.parts.length > 32) throw new A2AInputError('message.parts is limited to 32 parts');
  const text = message.parts.map(p => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n').trim();
  const dataPart = message.parts.find(p => p && typeof p.data === 'object' && p.data !== null && !Array.isArray(p.data));
  return { text, data: dataPart ? dataPart.data : null, messageId: message.messageId, contextId: message.contextId || '' };
}

export function agentReply({ text, data, contextId = '' }) {
  const parts = [];
  if (text) parts.push({ text: String(text) });
  if (data !== undefined && data !== null) parts.push({ data });
  if (!parts.length) parts.push({ text: '' });
  return { message: { messageId: crypto.randomUUID(), ...(contextId ? { contextId } : {}), role: 'ROLE_AGENT', parts } };
}

function respond(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': `${A2A_MEDIA_TYPE}; charset=utf-8`, 'x-content-type-options': 'nosniff', ...headers } });
}
function problem(status, title, detail, headers = {}) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return new Response(JSON.stringify({ type: `https://a2a-protocol.org/errors/${slug}`, title, status, detail }), { status, headers: { 'content-type': 'application/problem+json; charset=utf-8', ...headers } });
}
async function readBody(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new A2AInputError(`request is limited to ${MAX_BYTES} bytes`, A2A_ERRORS.INVALID_REQUEST, 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new A2AInputError(`request is limited to ${MAX_BYTES} bytes`, A2A_ERRORS.INVALID_REQUEST, 413);
  try { return JSON.parse(raw); } catch { throw new A2AInputError('body must be JSON', A2A_ERRORS.PARSE, 400); }
}

/**
 * Create the A2A routes for one agent.
 *   card():        returns the agent card (built with buildAgentCard)
 *   handle(input): async ({ text, data, contextId, request }) => { text, data }
 * Returns { match(request) -> boolean, fetch(request) -> Response }.
 */
export function createA2AHandler({ card, handle, cors = {} }) {
  const answer = async (body, request) => {
    const input = readMessage(body?.message);
    const out = await handle({ ...input, request });
    return agentReply({ ...out, contextId: input.contextId });
  };
  const versionOk = request => {
    const v = request.headers.get('a2a-version');
    return !v || SUPPORTED_VERSIONS.includes(v);
  };
  const paths = new Set(['/.well-known/agent-card.json', '/.well-known/agent.json', '/message:send', '/a2a']);
  return {
    match(request) {
      const p = new URL(request.url).pathname;
      return paths.has(p) || p.startsWith('/tasks/') || p === '/message:stream';
    },
    async fetch(request) {
      const url = new URL(request.url);
      const p = url.pathname;
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, a2a-version, a2a-extensions' } });
      if (p === '/.well-known/agent-card.json' || p === '/.well-known/agent.json') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return problem(405, 'Method Not Allowed', 'Use GET.', { allow: 'GET', ...cors });
        return new Response(JSON.stringify(card()), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300', ...cors } });
      }
      if (p === '/message:send') {
        if (request.method !== 'POST') return problem(405, 'Method Not Allowed', 'Use POST.', { allow: 'POST', ...cors });
        if (!versionOk(request)) return problem(400, 'Version Not Supported', `Supported A2A versions: ${SUPPORTED_VERSIONS.join(', ')}.`, cors);
        try { return respond(await answer(await readBody(request), request), 200, cors); }
        catch (e) { return e instanceof A2AInputError ? problem(e.status, 'Invalid Request', e.message, cors) : problem(500, 'Internal Error', 'The agent failed to answer.', cors); }
      }
      if (p === '/message:stream') return problem(501, 'Unsupported Operation', 'This agent does not stream; use message:send.', cors);
      if (p.startsWith('/tasks/')) return problem(404, 'Task Not Found', 'This agent answers with direct messages and stores no tasks.', cors);
      if (p === '/a2a') {
        if (request.method !== 'POST') return problem(405, 'Method Not Allowed', 'Use POST with JSON-RPC 2.0.', { allow: 'POST', ...cors });
        let rpc;
        try { rpc = await readBody(request); }
        catch (e) { return respond({ jsonrpc: '2.0', id: null, error: { code: e.code || A2A_ERRORS.PARSE, message: e.message } }, 200, cors); }
        const id = rpc?.id ?? null;
        const fail = (code, message) => respond({ jsonrpc: '2.0', id, error: { code, message } }, 200, cors);
        if (rpc?.jsonrpc !== '2.0' || typeof rpc?.method !== 'string') return fail(A2A_ERRORS.INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request');
        if (!versionOk(request)) return fail(A2A_ERRORS.VERSION_NOT_SUPPORTED, `Supported A2A versions: ${SUPPORTED_VERSIONS.join(', ')}`);
        switch (rpc.method) {
          case 'SendMessage':
          case 'message/send':
            try { return respond({ jsonrpc: '2.0', id, result: await answer(rpc.params, request) }, 200, cors); }
            catch (e) { return fail(e instanceof A2AInputError ? e.code : A2A_ERRORS.INTERNAL, e instanceof A2AInputError ? e.message : 'The agent failed to answer.'); }
          case 'GetTask': case 'CancelTask': case 'tasks/get': case 'tasks/cancel':
            return fail(A2A_ERRORS.TASK_NOT_FOUND, 'This agent answers with direct messages and stores no tasks.');
          case 'SendStreamingMessage': case 'SubscribeToTask': case 'message/stream':
            return fail(A2A_ERRORS.UNSUPPORTED_OPERATION, 'Streaming is not supported; use SendMessage.');
          case 'CreateTaskPushNotificationConfig': case 'GetTaskPushNotificationConfig': case 'ListTaskPushNotificationConfigs': case 'DeleteTaskPushNotificationConfig':
            return fail(A2A_ERRORS.PUSH_NOT_SUPPORTED, 'Push notifications are not supported.');
          default:
            return fail(A2A_ERRORS.METHOD_NOT_FOUND, `Method not found: ${String(rpc.method).slice(0, 80)}`);
        }
      }
      return problem(404, 'Not Found', 'Unknown A2A route.', cors);
    }
  };
}
