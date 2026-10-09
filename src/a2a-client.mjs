// Minimal A2A 1.0 client used inside the Pactwire service (no dependencies, Worker-safe).
// The tests also drive Pactwire with the official @a2a-js/sdk client, so both sides are covered.

export const IDENTITY_EXT = 'urn:pactwire:identity:1';

export class FetchGuardError extends Error {}

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^22[4-9]\./, /^2[3-5]\d\./];
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** True for loopback, private, link-local, multicast and other non-public IP literals. */
export function isPrivateAddress(ip) {
  const a = String(ip).replace(/^\[|\]$/g, '').toLowerCase();
  if (IPV4.test(a)) return PRIVATE_V4.some(r => r.test(a));
  if (!a.includes(':')) return false;
  if (a === '::' || a === '::1') return true;
  if (a.startsWith('::ffff:')) return isPrivateAddress(a.slice(7)) || !IPV4.test(a.slice(7));
  return /^(fc|fd|fe[89ab]|ff)/.test(a);
}

/** Only public https URLs, unless the server runs in local dev mode. */
export function assertFetchable(raw, { allowLocal = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new FetchGuardError('not a valid URL'); }
  if (url.username || url.password) throw new FetchGuardError('URLs with credentials are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || isPrivateAddress(host) || /^\d+$/.test(host);
  if (local && !allowLocal) throw new FetchGuardError('private and local addresses are not allowed');
  if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:')) throw new FetchGuardError('only https URLs are allowed');
  return url;
}

export function canonicalOrigin(raw, opts) {
  return assertFetchable(raw, opts).origin;
}

async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new FetchGuardError(`response larger than ${maxBytes} bytes`); }
    chunks.push(value);
  }
  const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

export async function guardedFetch(url, init = {}, { fetchImpl = fetch, allowLocal = false, resolveHost = null, timeoutMs = 10000, maxBytes = 1_000_000 } = {}) {
  const u = assertFetchable(url, { allowLocal });
  if (resolveHost) { try { await resolveHost(u.hostname.replace(/^\[|\]$/g, '')); } catch (e) { throw new FetchGuardError(e.message); } }
  const r = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const bytes = await readCapped(r, maxBytes);
  return { status: r.status, headers: r.headers, bytes, text: () => new TextDecoder().decode(bytes), json: () => JSON.parse(new TextDecoder().decode(bytes)) };
}

export async function fetchAgentCard(origin, opts = {}) {
  const r = await guardedFetch(`${origin}/.well-known/agent-card.json`, { headers: { accept: 'application/json' } }, { ...opts, maxBytes: 256 * 1024 });
  if (r.status !== 200) throw new FetchGuardError(`agent card returned HTTP ${r.status}`);
  let card; try { card = r.json(); } catch { throw new FetchGuardError('agent card is not JSON'); }
  if (!card || typeof card !== 'object' || typeof card.name !== 'string') throw new FetchGuardError('agent card has no name');
  return card;
}

export function pickInterface(card) {
  const ifaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
  const ok = ifaces.filter(i => typeof i?.url === 'string' && String(i.protocolVersion || '').startsWith('1.'));
  return ok.find(i => i.protocolBinding === 'HTTP+JSON') || ok.find(i => i.protocolBinding === 'JSONRPC') || null;
}

export function identityFromCard(card) {
  const ext = (card?.capabilities?.extensions || []).find(e => e?.uri === IDENTITY_EXT);
  const jwk = ext?.params?.publicKeyJwk;
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') return null;
  return { publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, kid: ext.params.kid || null };
}

/** Send one A2A message and return { text, data } of the reply. */
export async function sendA2A(iface, { text, data }, opts = {}) {
  const parts = [];
  if (text) parts.push({ text });
  if (data) parts.push({ data });
  const message = { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts };
  let body, url = iface.url;
  if (iface.protocolBinding === 'JSONRPC') body = { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message } };
  else { url = `${iface.url.replace(/\/$/, '')}/message:send`; body = { message }; }
  const r = await guardedFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'a2a-version': '1.0', accept: 'application/a2a+json, application/json' }, body: JSON.stringify(body) }, { timeoutMs: 30000, ...opts });
  if (r.status !== 200) throw new Error(`A2A call returned HTTP ${r.status}`);
  let json; try { json = r.json(); } catch { throw new Error('A2A reply is not JSON'); }
  if (iface.protocolBinding === 'JSONRPC') { if (json.error) throw new Error(`A2A error ${json.error.code}: ${json.error.message}`); json = json.result; }
  const msg = json?.message || json?.task?.status?.message || (json?.task?.artifacts?.[0] ? { parts: json.task.artifacts[0].parts } : null);
  if (!msg || !Array.isArray(msg.parts)) throw new Error('A2A reply has no message');
  return {
    text: msg.parts.map(p => p?.text || '').filter(Boolean).join('\n'),
    data: msg.parts.find(p => p && typeof p.data === 'object' && p.data !== null)?.data ?? null
  };
}
