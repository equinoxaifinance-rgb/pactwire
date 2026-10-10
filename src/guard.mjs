// Pactwire guard: check what a paid API call gave you before your agent trusts it or buys again.
//
// x402 sellers are paid before (or as) they answer, and nobody checks the answer. A call can settle
// on-chain and still return a 500, an empty body, or JSON that is not what the listing promised.
// The guard sits under any x402 paying fetch, looks at every paid response, records a signed verdict
// in a local hash-chained ledger, and refuses (before any payment) to call an endpoint or seller
// that keeps charging for nothing.
//
//   import { wrapFetchWithPayment } from '@x402/fetch';
//   const guard = createGuard({ ledger: await fileLedger('.pactwire/ledger.jsonl') });
//   const pay = wrapFetchWithPayment(guard.fetch, client);   // guard goes UNDER the payer
//   const res = await pay(url);
//   const verdict = guard.verdictFor(res);                   // { ok, paid, problems, ... }
//
// It never pays, signs payments or holds keys for money. It only reads requests and responses.
import { canonical, generateKeyPair, keyId, sign, verify, sha256Hex } from './crypto.mjs';
import { runChecks, validateChecks, validateSchema } from './checks.mjs';

export const GENESIS = '0'.repeat(64);
const MAX_BODY = 2_000_000;

export class GuardBlockedError extends Error {
  constructor(resource, reason) {
    super(`pactwire guard: not calling ${resource}: ${reason} (nothing was paid). Call guard.unblock(...) to try it again.`);
    this.name = 'GuardBlockedError'; this.resource = resource; this.reason = reason;
  }
}

function b64json(text) {
  try {
    const bin = atob(String(text).trim());
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0))));
  } catch { return null; }
}

/** The endpoint a request is for: origin + path, without query or fragment. */
export function resourceKey(url) {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return String(url); }
}

/**
 * Read an x402 402 challenge (v2 PAYMENT-REQUIRED header, or v1 JSON body) into the parts the guard uses:
 * price, payTo, network, and what the seller declared its output looks like.
 */
export function readChallenge(headers, bodyJson) {
  const fromHeader = headers?.get?.('payment-required') ? b64json(headers.get('payment-required')) : null;
  const pr = fromHeader || (bodyJson && bodyJson.x402Version === 1 && Array.isArray(bodyJson.accepts) ? bodyJson : null);
  if (!pr || !Array.isArray(pr.accepts) || !pr.accepts.length) return null;
  const a = pr.accepts[0];
  const declared = declaredOutput(pr);
  return {
    x402Version: pr.x402Version,
    payTo: a.payTo || null,
    network: a.network || null,
    asset: a.asset || null,
    amount: String(a.amount ?? a.maxAmountRequired ?? ''),
    description: pr.resource?.description || a.description || '',
    declared,
  };
}

/**
 * What the seller says it returns. Bazaar v2 nests the response schema at
 * extensions.bazaar.schema.properties.output.properties.example, and the example at
 * extensions.bazaar.info.output.example. v1 puts an example at accepts[0].outputSchema.output.
 * A schema that only says { type: "object" } is the Bazaar default, not a declaration, so it is dropped.
 */
export function declaredOutput(pr) {
  const bz = pr?.extensions?.bazaar;
  let schema = bz?.schema?.properties?.output?.properties?.example;
  if (schema && typeof schema === 'object' && Object.keys(schema).every(k => k === 'type')) schema = null;
  let example = bz?.info?.output?.example;
  if (example === undefined && pr?.x402Version === 1) {
    const os = pr.accepts?.[0]?.outputSchema;
    if (os && typeof os === 'object' && os.output !== undefined) example = os.output;
  }
  return { schema: schema || null, example: example === undefined ? null : example };
}

/** Decode the settlement header a seller returns after taking payment (v2 PAYMENT-RESPONSE, v1 X-PAYMENT-RESPONSE). */
export function readSettlement(headers) {
  const raw = headers?.get?.('payment-response') || headers?.get?.('x-payment-response');
  if (!raw) return null;
  const s = b64json(raw);
  return s && typeof s === 'object' ? s : { success: null, undecodable: true };
}

const isEmptyValue = v => v === null || v === '' || (Array.isArray(v) && v.length === 0) || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

/**
 * Judge one response. Pure: no network, no ledger.
 * paidState: 'yes' (settlement header says success), 'no' (no payment was sent, or settlement failed),
 * 'likely' (payment was sent, the seller returned no settlement header).
 * Problems with level 'fail' mean the buyer got nothing usable; 'warn' means look before trusting it.
 */
export async function judgeResponse({ status, contentType = '', bodyText = '', paidState = 'yes', declared = null, checks = [], ctx = {} }) {
  const problems = [];
  const fail = (code, detail) => problems.push({ level: 'fail', code, detail });
  const warn = (code, detail) => problems.push({ level: 'warn', code, detail });
  let json; let parsed = false;
  if (status < 200 || status > 299) fail('http_error', `status ${status}`);
  if (!bodyText || !bodyText.trim()) fail('empty_body', 'the response body is empty');
  else if (/json/i.test(contentType) || /^\s*[[{]/.test(bodyText)) {
    try { json = JSON.parse(bodyText); parsed = true; } catch { if (/json/i.test(contentType)) fail('bad_json', 'says JSON but does not parse'); }
  }
  if (parsed && status >= 200 && status <= 299) {
    if (isEmptyValue(json)) fail('empty_result', 'the JSON is empty');
    else if (json && typeof json === 'object' && !Array.isArray(json) && (json.error || json.errors) && Object.keys(json).length <= 3) warn('error_in_body', `status ${status} but the body reports an error: ${canonical(json.error ?? json.errors).slice(0, 160)}`);
    if (declared?.schema) {
      const errs = validateSchema(declared.schema, json);
      if (errs.length) fail('off_schema', `does not match the seller's declared output schema: ${errs.slice(0, 3).join('; ')}`);
    }
    if (declared?.example && typeof declared.example === 'object' && !Array.isArray(declared.example) && json && typeof json === 'object' && !Array.isArray(json)) {
      const missing = Object.keys(declared.example).filter(k => !(k in json));
      if (missing.length) warn('missing_example_fields', `fields in the seller's example but not in the response: ${missing.slice(0, 8).join(', ')}`);
      const emptied = Object.keys(declared.example).filter(k => k in json && Array.isArray(declared.example[k]) && declared.example[k].length > 0 && Array.isArray(json[k]) && json[k].length === 0);
      if (emptied.length) warn('empty_list', `came back empty where the example has results: ${emptied.slice(0, 8).join(', ')}`);
    }
  }
  let checkResults = [];
  if (checks.length) {
    const output = parsed ? json : bodyText;
    checkResults = (await runChecks(checks, output, ctx)).results;
    for (const r of checkResults) if (!r.pass) fail('check_failed', `${r.type}: ${r.detail}`);
  }
  const failed = problems.some(p => p.level === 'fail');
  return { ok: !failed, paid: paidState, paidForNothing: failed && paidState !== 'no', problems, checks: checkResults };
}

/** In-memory ledger. Same interface as fileLedger: entries() and append(entry). */
export function memoryLedger(initial = []) {
  const rows = [...initial];
  return { async entries() { return rows; }, async append(e) { rows.push(e); } };
}

/** Verify a ledger: every entry signed by its key and chained to the one before. */
export async function verifyLedger(rows) {
  let prev = GENESIS;
  for (const [i, r] of rows.entries()) {
    if (r.payload?.prev !== prev) return { ok: false, at: i, why: 'chain broken' };
    if (r.payload?.kid !== await keyId(r.payload?.publicJwk || {})) return { ok: false, at: i, why: 'key id does not match key' };
    if (!await verify(r, r.payload.publicJwk)) return { ok: false, at: i, why: 'bad signature' };
    prev = await sha256Hex(canonical(r));
  }
  return { ok: true, count: rows.length };
}

const DEFAULT_POLICY = {
  // Stop calling an endpoint when it charged for nothing this many times in its last `window` paid calls.
  endpointFailures: 2, window: 5,
  // Stop paying a seller (payTo address) across all its endpoints after this many in its last `sellerWindow`.
  sellerFailures: 3, sellerWindow: 10,
};

/** Per-endpoint and per-seller numbers from a ledger. */
export function summarize(rows) {
  const by = new Map();
  for (const r of rows) {
    const p = r.payload; if (p?.kind !== 'verdict') continue;
    for (const key of [`endpoint:${p.resource}`, p.payTo ? `seller:${p.payTo}` : null].filter(Boolean)) {
      const s = by.get(key) || { key, calls: 0, paid: 0, paidForNothing: 0, warnings: 0, spent: 0n, wasted: 0n, last: null };
      s.calls++;
      if (p.paid !== 'no') { s.paid++; s.spent += BigInt(/^\d+$/.test(p.amount || '') ? p.amount : 0); }
      if (p.paidForNothing) { s.paidForNothing++; s.wasted += BigInt(/^\d+$/.test(p.amount || '') ? p.amount : 0); }
      if (p.problems?.some(x => x.level === 'warn')) s.warnings++;
      s.last = p.at; by.set(key, s);
    }
  }
  return [...by.values()].map(s => ({ ...s, spent: s.spent.toString(), wasted: s.wasted.toString() }));
}

/**
 * createGuard({ ledger, key, policy, checks, fetch, now })
 *  ledger  memoryLedger() (default) or fileLedger(path)
 *  key     { privateJwk, publicJwk } that signs your verdicts (generated if absent; pass one to keep a stable identity)
 *  checks  default Pactwire checks for every response, or a function (resource) => checks
 *  fetch   the plain fetch to call through (default globalThis.fetch)
 * Returns { fetch, verdictFor, check, unblock, blocked, report }.
 */
export function createGuard({ ledger = memoryLedger(), key, policy = {}, checks = [], fetch: baseFetch = globalThis.fetch, now = () => new Date() } = {}) {
  const pol = { ...DEFAULT_POLICY, ...policy };
  const verdicts = new WeakMap();
  const challenges = new Map(); // resource -> last challenge seen
  const unblocked = new Map(); // key -> ledger length at unblock time
  let keyP = key ? Promise.resolve(key) : generateKeyPair();
  let tail = null; // serialize ledger writes
  const checksFor = resource => (typeof checks === 'function' ? checks(resource) : checks) || [];
  if (typeof checks !== 'function' && checks.length) validateChecks(checks);

  async function append(payload) {
    const run = async () => {
      const k = await keyP;
      const rows = await ledger.entries();
      const prev = rows.length ? await sha256Hex(canonical(rows[rows.length - 1])) : GENESIS;
      const entry = await sign({ ...payload, prev, kid: await keyId(k.publicJwk), publicJwk: k.publicJwk }, 'pactwire-guard', k.privateJwk);
      await ledger.append(entry);
      return entry;
    };
    tail = (tail || Promise.resolve()).then(run, run);
    return tail;
  }

  async function blockedReason(resource, payTo) {
    const rows = (await ledger.entries()).filter(r => r.payload?.kind === 'verdict');
    const since = k => unblocked.get(k) ?? 0;
    const recent = (match, n, k) => rows.slice(since(k)).filter(match).filter(r => r.payload.paid !== 'no').slice(-n);
    const eKey = `endpoint:${resource}`;
    const e = recent(r => r.payload.resource === resource, pol.window, eKey).filter(r => r.payload.paidForNothing).length;
    if (e >= pol.endpointFailures) return `it charged for nothing ${e} times in its last ${pol.window} paid calls`;
    if (payTo) {
      const sKey = `seller:${payTo}`;
      const s = recent(r => r.payload.payTo === payTo, pol.sellerWindow, sKey).filter(r => r.payload.paidForNothing).length;
      if (s >= pol.sellerFailures) return `seller ${payTo} charged for nothing ${s} times in its last ${pol.sellerWindow} paid calls`;
    }
    return null;
  }

  async function guardedFetch(input, init) {
    const request = new Request(input, init);
    const resource = resourceKey(request.url);
    const paying = request.headers.has('payment-signature') || request.headers.has('x-payment');
    if (!paying) {
      // First, unpaid request. Refuse here, before any money moves, if this endpoint or its seller keeps failing.
      const reason = await blockedReason(resource, challenges.get(resource)?.payTo);
      if (reason) throw new GuardBlockedError(resource, reason);
    }
    const response = await baseFetch(request);
    if (response.status === 402 && !paying) {
      let body = null;
      try { body = JSON.parse(await response.clone().text()); } catch { /* header-only challenge */ }
      const ch = readChallenge(response.headers, body);
      if (ch) {
        challenges.set(resource, ch);
        // We now know the seller: re-check the seller-wide rule before the payer signs anything.
        const reason = await blockedReason(resource, ch.payTo);
        if (reason) throw new GuardBlockedError(resource, reason);
      }
      return response;
    }
    if (!paying && response.status !== 402) return response; // free endpoint, nothing to judge
    const ch = challenges.get(resource) || null;
    const settlement = readSettlement(response.headers);
    const paidState = settlement ? (settlement.success === false ? 'no' : settlement.success === true ? 'yes' : 'likely') : (response.status === 402 ? 'no' : 'likely');
    const bodyText = (await response.clone().text()).slice(0, MAX_BODY);
    const v = await judgeResponse({ status: response.status, contentType: response.headers.get('content-type') || '', bodyText, paidState, declared: ch?.declared, checks: checksFor(resource) });
    const entry = await append({
      kind: 'verdict', at: now().toISOString(), resource, method: request.method, status: response.status,
      payTo: ch?.payTo || null, network: settlement?.network || ch?.network || null, amount: settlement?.amount || ch?.amount || null,
      transaction: settlement?.transaction || null, paid: paidState, ok: v.ok, paidForNothing: v.paidForNothing,
      problems: v.problems, bodySha256: await sha256Hex(bodyText),
    });
    verdicts.set(response, { ...v, resource, payTo: ch?.payTo || null, transaction: settlement?.transaction || null, receipt: entry });
    return response;
  }

  return {
    fetch: guardedFetch,
    /** The verdict for a response returned through the guard (undefined if the call was free or blocked). */
    verdictFor: response => verdicts.get(response),
    /** Judge a response you got some other way (MPP, a card API, an MCP tool). Records it like any other. */
    async check({ resource, status = 200, body, contentType = 'application/json', paid = 'yes', payTo = null, amount = null, transaction = null, declared = null, checks: extra = [] }) {
      const bodyText = typeof body === 'string' ? body : canonical(body ?? null);
      const v = await judgeResponse({ status, contentType, bodyText, paidState: paid, declared, checks: [...checksFor(resource), ...extra] });
      const entry = await append({ kind: 'verdict', at: now().toISOString(), resource: resourceKey(resource), method: null, status, payTo, network: null, amount, transaction, paid, ok: v.ok, paidForNothing: v.paidForNothing, problems: v.problems, bodySha256: await sha256Hex(bodyText) });
      return { ...v, receipt: entry };
    },
    /** Allow an endpoint (url) or seller ({ payTo }) again; only failures after this point count. */
    async unblock(target) {
      const k = typeof target === 'object' && target?.payTo ? `seller:${target.payTo}` : `endpoint:${resourceKey(target)}`;
      unblocked.set(k, (await ledger.entries()).filter(r => r.payload?.kind === 'verdict').length);
    },
    /** Why a call would be refused right now, or null. */
    blocked: (url, payTo) => blockedReason(resourceKey(url), payTo ?? challenges.get(resourceKey(url))?.payTo),
    async report() { return summarize(await ledger.entries()); },
    publicKey: async () => (await keyP).publicJwk,
  };
}
