// Pactwire core: the deal engine. No HTTP here, so the same logic sits behind
// the REST API, the A2A agent and the MCP server.
//
// A deal moves through these states:
//   proposed  -> buyer signed an offer (task, price, acceptance checks, deadline, rail)
//   accepted  -> seller signed the exact same terms (by their hash)
//   funded    -> the buyer's money is held by the rail; nobody can spend it
//   released  -> delivery passed every check; the seller is paid
//   refunded  -> delivery failed a check, or the deadline passed; the buyer gets the money back
//   cancelled -> called off before any money moved
// Every transition writes a signed, chained receipt to the public log.

import { sign, verify, hashJson, canonical, keyId } from './crypto.mjs';
import { validateChecks, runChecks, CheckDefinitionError } from './checks.mjs';
import { appendReceipt, dealReceipts } from './receipts.mjs';
import { RailError } from './rails.mjs';
import { canonicalOrigin, fetchAgentCard, identityFromCard, pickInterface, sendA2A, guardedFetch, FetchGuardError } from './a2a-client.mjs';

export class PactwireError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new PactwireError(code, message, status); };

const TERMS_VERSION = 'pactwire/1';
const MAX_TASK_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_AMOUNT = 100_000_00; // 100,000.00 in minor units
const ACTIONS = ['accept', 'fund', 'deliver', 'cancel'];

export function createPactwire({ db, service, rails, allowLocal = false, resolveHost = null, fetchImpl = fetch, feeBps = 0, now = () => new Date(), notifySellers = true }) {
  const fetchOpts = { allowLocal, fetchImpl, resolveHost };
  const iso = () => now().toISOString();
  const receipt = (kind, dealId, data) => appendReceipt(db, service, { kind, dealId, data });

  // ---------- agents (directory + identity) ----------

  async function registerAgent(rawOrigin) {
    let origin;
    try { origin = canonicalOrigin(rawOrigin, { allowLocal }); } catch (e) { fail('bad_origin', e.message); }
    let card;
    try { card = await fetchAgentCard(origin, fetchOpts); } catch (e) { fail('card_unreachable', `could not read ${origin}/.well-known/agent-card.json: ${e.message}`, 422); }
    const identity = identityFromCard(card);
    if (!identity) fail('no_identity', `agent card must publish an Ed25519 key in capabilities.extensions with uri "urn:pactwire:identity:1" (params.publicKeyJwk)`, 422);
    const iface = pickInterface(card);
    const checks = [{ name: 'card', ok: true }, { name: 'identity_key', ok: true }];
    let verified = 0;
    if (!iface) checks.push({ name: 'a2a_interface', ok: false, error: 'no A2A 1.0 interface in supportedInterfaces' });
    else {
      checks.push({ name: 'a2a_interface', ok: true, detail: `${iface.protocolBinding} ${iface.url}` });
      try {
        await sendA2A(iface, { data: { pactwire: 'ping' } }, fetchOpts);
        checks.push({ name: 'a2a_message', ok: true });
        verified = 1;
      } catch (e) { checks.push({ name: 'a2a_message', ok: false, error: String(e.message).slice(0, 200) }); }
    }
    const kid = await keyId(identity.publicJwk);
    const skills = (card.skills || []).slice(0, 50).map(s => ({ id: String(s.id || '').slice(0, 80), name: String(s.name || '').slice(0, 120), tags: (s.tags || []).slice(0, 10).map(t => String(t).slice(0, 40)) }));
    const row = {
      id: origin, name: String(card.name).slice(0, 120), card_url: `${origin}/.well-known/agent-card.json`,
      a2a_url: iface?.url || null, a2a_binding: iface?.protocolBinding || null, public_jwk: JSON.stringify(identity.publicJwk), key_id: kid,
      skills: JSON.stringify(skills), description: String(card.description || '').slice(0, 500), verified, last_check: JSON.stringify(checks), last_check_at: iso()
    };
    const existing = await db.prepare('SELECT key_id FROM agents WHERE id = ?').bind(origin).first();
    await db.prepare(`INSERT INTO agents (id, name, card_url, a2a_url, a2a_binding, public_jwk, key_id, skills, description, verified, last_check, last_check_at, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, card_url = excluded.card_url, a2a_url = excluded.a2a_url, a2a_binding = excluded.a2a_binding,
        public_jwk = excluded.public_jwk, key_id = excluded.key_id, skills = excluded.skills, description = excluded.description,
        verified = excluded.verified, last_check = excluded.last_check, last_check_at = excluded.last_check_at`)
      .bind(row.id, row.name, row.card_url, row.a2a_url, row.a2a_binding, row.public_jwk, row.key_id, row.skills, row.description, row.verified, row.last_check, row.last_check_at, iso()).run();
    if (!existing || existing.key_id !== kid) await receipt('agent.key', null, { agent: origin, kid, publicJwk: identity.publicJwk, replaced: existing?.key_id || null });
    return getAgent(origin);
  }

  /**
   * Sandbox only: a "guest" buyer identified by its public key alone, so anyone can try a deal
   * in a minute without hosting an agent card. Guest ids use the reserved .invalid domain,
   * guests can only buy, and only sandbox deals ever involve them.
   */
  async function registerGuest(publicJwk, name = 'Guest buyer') {
    if (!rails.sandbox) fail('not_sandbox', 'guest buyers exist only in sandbox mode', 404);
    if (publicJwk?.kty !== 'OKP' || publicJwk?.crv !== 'Ed25519' || !/^[A-Za-z0-9_-]{43}$/.test(publicJwk?.x || '')) fail('bad_key', 'publicJwk must be an Ed25519 public JWK');
    const pub = { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x };
    const kid = await keyId(pub);
    const id = `https://guest-${(await hashJson(pub)).slice(0, 24)}.invalid`;
    const r = await db.prepare(`INSERT INTO agents (id, name, card_url, a2a_url, a2a_binding, public_jwk, key_id, skills, description, verified, last_check, last_check_at, registered_at)
      VALUES (?, ?, '', NULL, NULL, ?, ?, '[]', 'Sandbox guest buyer', 0, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(id, String(name).slice(0, 60), JSON.stringify(pub), kid, JSON.stringify([{ name: 'guest', ok: true, detail: 'sandbox guest: identified by key only' }]), iso(), iso()).run();
    // Like any agent key, a guest key goes in the public log, so auditors can check guest signatures too.
    if (r.meta?.changes) await receipt('agent.key', null, { agent: id, kid, publicJwk: pub, replaced: null, guest: true });
    return getAgent(id);
  }
  const isGuest = id => /^https:\/\/guest-[0-9a-f]{24}\.invalid$/.test(id);

  function agentView(row) {
    if (!row) return null;
    return {
      id: row.id, name: row.name, description: row.description, cardUrl: row.card_url,
      a2a: row.a2a_url ? { url: row.a2a_url, protocolBinding: row.a2a_binding } : null,
      publicJwk: JSON.parse(row.public_jwk), kid: row.key_id, skills: JSON.parse(row.skills),
      verified: !!row.verified, lastCheck: row.last_check ? JSON.parse(row.last_check) : null, lastCheckAt: row.last_check_at, registeredAt: row.registered_at
    };
  }

  async function getAgent(id) {
    return agentView(await db.prepare('SELECT * FROM agents WHERE id = ?').bind(id).first());
  }

  async function listAgents({ q = '', skill = '', includeUnverified = false, limit = 50 } = {}) {
    const { results } = await db.prepare(`SELECT * FROM agents WHERE (? = 1 OR verified = 1) ORDER BY verified DESC, registered_at ASC LIMIT 500`).bind(includeUnverified ? 1 : 0).all();
    const needle = String(q).toLowerCase();
    const out = [];
    for (const row of results) {
      const a = agentView(row);
      if (skill && !a.skills.some(s => s.id === skill || s.tags.includes(skill))) continue;
      if (needle && !`${a.name} ${a.description} ${a.skills.map(s => `${s.id} ${s.name} ${s.tags.join(' ')}`).join(' ')}`.toLowerCase().includes(needle)) continue;
      out.push({ ...a, record: await agentRecord(a.id, { signed: false }) });
      if (out.length >= Math.min(limit, 200)) break;
    }
    return out;
  }

  /** Track record built only from real deals settled through Pactwire. */
  async function agentRecord(id, { signed = true } = {}) {
    // Count from the public log itself, up to a fixed point in it, so the signed record always equals what anyone
    // rebuilds from the log up to logSeq. (A deal's state changes a moment before its settlement receipt is written;
    // counting from the deals table would briefly count a settlement the log does not show yet.)
    const logSeq = (await db.prepare('SELECT MAX(seq) AS s FROM receipts').first())?.s || 0;
    const rows = (await db.prepare(`SELECT d.id, d.rail, d.currency, d.buyer, d.seller, d.amount, r.kind, r.body FROM receipts r JOIN deals d ON d.id = r.deal_id
      WHERE r.seq <= ? AND (d.seller = ? OR d.buyer = ?) AND r.kind IN ('deal.released', 'deal.refunded', 'deal.disputed') ORDER BY r.seq`).bind(logSeq, id, id).all()).results;
    const byDeal = new Map();
    for (const r of rows) {
      const d = byDeal.get(r.id) || { rail: r.rail, currency: r.currency, buyer: r.buyer, seller: r.seller, amount: r.amount, state: null, dispute: null };
      if (r.kind === 'deal.disputed') d.dispute = JSON.parse(r.body).payload.data.status || 'disputed';
      else d.state = r.kind === 'deal.released' ? 'released' : 'refunded';
      byDeal.set(r.id, d);
    }
    const results = [...byDeal.values()].filter(d => d.state);
    const tally = list => {
      const sold = list.filter(d => d.seller === id);
      const bought = list.filter(d => d.buyer === id);
      const paid = {};
      for (const d of sold) if (d.state === 'released') paid[d.currency] = (paid[d.currency] || 0) + d.amount;
      return {
        seller: { settledDeals: sold.length, passed: sold.filter(d => d.state === 'released').length, failedOrLate: sold.filter(d => d.state === 'refunded').length, distinctPayingBuyers: new Set(sold.filter(d => d.state === 'released').map(d => d.buyer)).size, paidMinorUnitsByCurrency: paid, disputed: sold.filter(d => d.dispute).length, disputesLost: sold.filter(d => d.dispute === 'lost').length },
        buyer: { settledDeals: bought.length, distinctSellers: new Set(bought.map(d => d.seller)).size }
      };
    };
    const real = results.filter(d => d.rail !== 'sandbox');
    const play = results.filter(d => d.rail === 'sandbox');
    const record = {
      agent: id, asOf: iso(), logSeq, ...tally(real), sandbox: tally(play),
      basis: 'seller/buyer count only deals funded with real money and settled through Pactwire; sandbox (play money) deals are shown separately. Counted from the public receipt log up to receipt logSeq.'
    };
    return signed ? sign(record, service.id, service.privateJwk) : record;
  }

  async function agentKey(id) {
    const row = await db.prepare('SELECT public_jwk FROM agents WHERE id = ?').bind(id).first();
    return row ? JSON.parse(row.public_jwk) : null;
  }

  async function requireSigned(signed, expectedSigner, action) {
    if (!signed || typeof signed !== 'object' || !signed.payload) fail('bad_signature', `${action} must be a signed object { payload, signer, sig }`);
    if (signed.signer !== expectedSigner) fail('wrong_signer', `${action} must be signed by ${expectedSigner}`, 403);
    const key = await agentKey(expectedSigner);
    if (!key) fail('unknown_agent', `${expectedSigner} is not registered; POST /v1/agents first`, 404);
    if (!(await verify(signed, key))) fail('bad_signature', `${action} signature does not verify against ${expectedSigner}'s published key`, 403);
  }

  // ---------- deals ----------

  function validateTerms(t) {
    if (!t || typeof t !== 'object') fail('bad_terms', 'terms must be an object');
    if (t.v !== TERMS_VERSION) fail('bad_terms', `terms.v must be "${TERMS_VERSION}"`);
    for (const k of ['buyer', 'seller']) {
      try { if (canonicalOrigin(t[k], { allowLocal }) !== t[k]) fail('bad_terms', `terms.${k} must be a bare origin like https://agent.example`); }
      catch (e) { if (e instanceof PactwireError) throw e; fail('bad_terms', `terms.${k}: ${e.message}`); }
    }
    if (t.buyer === t.seller) fail('bad_terms', 'buyer and seller must differ');
    if (typeof t.skill !== 'string' || !t.skill || t.skill.length > 80) fail('bad_terms', 'terms.skill is required');
    if (new TextEncoder().encode(canonical(t.task ?? null)).byteLength > MAX_TASK_BYTES) fail('bad_terms', `terms.task is limited to ${MAX_TASK_BYTES} bytes`);
    if (!t.price || !Number.isInteger(t.price.amount) || t.price.amount <= 0 || t.price.amount > MAX_AMOUNT) fail('bad_terms', 'terms.price.amount must be a positive integer in minor units (cents)');
    if (!/^[a-z]{3}$/.test(t.price.currency || '')) fail('bad_terms', 'terms.price.currency must be a 3-letter lowercase code like "usd"');
    if (!rails[t.rail]) fail('bad_terms', `terms.rail must be one of: ${Object.keys(rails).join(', ')}`);
    const due = Date.parse(t.deliverBy);
    if (!Number.isFinite(due) || due <= now().getTime()) fail('bad_terms', 'terms.deliverBy must be a future ISO time');
    if (due - now().getTime() > rails[t.rail].maxHoldDays * 86400000) fail('bad_terms', `on the ${t.rail} rail, deliverBy must be within ${rails[t.rail].maxHoldDays} days`);
    if (typeof t.nonce !== 'string' || t.nonce.length < 8 || t.nonce.length > 64) fail('bad_terms', 'terms.nonce must be 8-64 characters');
    if (t.dispatch !== undefined && typeof t.dispatch !== 'boolean') fail('bad_terms', 'terms.dispatch must be true or false');
    if (t.payout?.stripeAccount && !/^acct_[A-Za-z0-9]+$/.test(t.payout.stripeAccount)) fail('bad_terms', 'terms.payout.stripeAccount must be acct_...');
    if (t.rail === 'stripe' && !t.payout?.stripeAccount) fail('bad_terms', 'the stripe rail pays the seller directly, so terms.payout.stripeAccount (the seller\'s Stripe Connect account, acct_...) is required');
    try { validateChecks(t.acceptance); } catch (e) { if (e instanceof CheckDefinitionError) fail('bad_checks', e.message); throw e; }
  }

  async function loadDeal(id) {
    const row = await db.prepare('SELECT * FROM deals WHERE id = ?').bind(id).first();
    if (!row) fail('deal_not_found', `no deal ${id}`, 404);
    return row;
  }

  // The delivered output is what the buyer paid for, so only the buyer and seller see it.
  // Everyone else sees that a signed delivery exists, its hash and the pass/fail of each check.
  // If the work fails the checks the buyer is refunded and does not get the work either:
  // neither side ends up with both the money and the work.
  function redactDelivery(delivery, verdict, why) {
    if (!delivery) return null;
    const { output, ...rest } = delivery.payload || {};
    return { signer: delivery.signer, sig: delivery.sig, payload: rest, outputHash: verdict?.outputHash ?? null, outputHidden: why };
  }

  /** viewer: 'seller' sees everything; 'buyer' sees the output once paid for; 'public' sees hashes and pass/fail. */
  function dealView(row, receipts, { viewer = 'public' } = {}) {
    const showOutput = viewer === 'seller' || (viewer === 'buyer' && row.state === 'released');
    const full = viewer !== 'public';
    const why = viewer === 'public' ? 'only the buyer and seller can read the output (send a signed read authorization)' : 'the work did not pass the agreed checks, so the buyer was refunded and the output stays with the seller';
    const terms = JSON.parse(row.terms);
    const delivery = row.delivery ? JSON.parse(row.delivery) : null;
    const verdict = row.verdict ? JSON.parse(row.verdict) : null;
    const publicVerdict = verdict && { ...verdict, results: verdict.results.map(({ detail, ...r }) => ({ ...r, detail: r.pass ? 'passed' : 'failed' })) };
    return {
      id: row.id, state: row.state, buyer: row.buyer, seller: row.seller, termsHash: row.terms_hash, terms,
      offer: JSON.parse(row.offer), acceptance: row.acceptance ? JSON.parse(row.acceptance) : null,
      rail: row.rail, railRef: row.rail_ref ? `${row.rail_ref.slice(0, 6)}…` : null,
      delivery: showOutput ? delivery : redactDelivery(delivery, verdict, why), verdict: full ? verdict : publicVerdict, outputVisible: showOutput && !!delivery,
      dispute: row.dispute || null, createdAt: row.created_at, updatedAt: row.updated_at, ...(receipts ? { receipts } : {})
    };
  }

  async function transition(row, to, fields = {}) {
    const sets = ['state = ?', 'version = version + 1', 'updated_at = ?'];
    const args = [to, iso()];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); args.push(v); }
    const r = await db.prepare(`UPDATE deals SET ${sets.join(', ')} WHERE id = ? AND state = ? AND version = ?`).bind(...args, row.id, row.state, row.version).run();
    if (!r.meta?.changes) fail('conflict', `deal ${row.id} changed while processing; reload and retry`, 409);
    return loadDeal(row.id);
  }

  async function checkAction(signed, row, action) {
    const p = signed?.payload || {};
    if (p.action !== action) fail('bad_action', `payload.action must be "${action}"`);
    if (p.dealId !== row.id || p.termsHash !== row.terms_hash) fail('terms_mismatch', 'payload.dealId and payload.termsHash must match the deal');
  }

  async function propose(offer) {
    const terms = offer?.payload;
    validateTerms(terms);
    if (!(await agentKey(terms.seller))) fail('unknown_agent', `seller ${terms.seller} is not registered`, 404);
    if (isGuest(terms.seller)) fail('bad_terms', 'guest identities can only buy');
    if (isGuest(terms.buyer) && terms.rail !== 'sandbox') fail('bad_terms', 'guest buyers can only use the sandbox rail');
    await requireSigned(offer, terms.buyer, 'offer');
    const termsHash = await hashJson(terms);
    const id = `deal_${termsHash.slice(0, 24)}`;
    const dup = await db.prepare('SELECT id FROM deals WHERE terms_hash = ?').bind(termsHash).first();
    if (dup) return getDeal(dup.id);
    await db.prepare(`INSERT INTO deals (id, buyer, seller, state, terms, terms_hash, offer, amount, currency, rail, deliver_by, created_at, updated_at)
      VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, terms.buyer, terms.seller, canonical(terms), termsHash, JSON.stringify(offer), terms.price.amount, terms.price.currency, terms.rail, new Date(Date.parse(terms.deliverBy)).toISOString(), iso(), iso()).run();
    await receipt('deal.proposed', id, { termsHash, buyer: terms.buyer, seller: terms.seller, price: terms.price, rail: terms.rail, deliverBy: terms.deliverBy, offerSig: offer.sig });
    if (notifySellers) await notifySeller(id).catch(() => {});
    return getDeal(id);
  }

  /** Tell the seller about the offer over A2A. A seller agent may answer with its signed acceptance. */
  async function notifySeller(id) {
    const row = await loadDeal(id);
    const seller = await getAgent(row.seller);
    if (!seller?.a2a) return;
    const reply = await sendA2A(seller.a2a, { text: `Pactwire offer ${id}`, data: { pactwire: 'offer', dealId: id, termsHash: row.terms_hash, terms: JSON.parse(row.terms), offer: JSON.parse(row.offer) } }, fetchOpts);
    if (reply.data?.acceptance) await accept(id, reply.data.acceptance);
  }

  async function accept(id, signed) {
    const row = await loadDeal(id);
    if (row.state !== 'proposed') { if (row.state === 'accepted' && row.acceptance) return getDeal(id); fail('bad_state', `deal is ${row.state}, not proposed`, 409); }
    await checkAction(signed, row, 'accept');
    await requireSigned(signed, row.seller, 'acceptance');
    await transition(row, 'accepted', { acceptance: JSON.stringify(signed) });
    await receipt('deal.accepted', id, { termsHash: row.terms_hash, seller: row.seller, acceptSig: signed.sig });
    return getDeal(id);
  }

  async function fund(id, signed, funding = {}) {
    const row = await loadDeal(id);
    if (row.state !== 'accepted') fail('bad_state', `deal is ${row.state}; only accepted deals can be funded`, 409);
    await checkAction(signed, row, 'fund');
    await requireSigned(signed, row.buyer, 'funding');
    if (Date.parse(row.deliver_by) <= now().getTime()) fail('expired', 'the delivery deadline has passed', 409);
    const terms = JSON.parse(row.terms);
    const rail = rails[row.rail];
    // Claim the deal first (version-guarded), so two simultaneous fund calls can never both reach the rail.
    const claimed = await transition(row, 'funding');
    let held;
    try { held = await rail.hold({ id, amount: row.amount, currency: row.currency, buyer: row.buyer, seller: row.seller, terms_hash: row.terms_hash, payout: terms.payout, fee: feeFor(row) }, funding); }
    catch (e) {
      await transition(claimed, 'accepted');
      if (e instanceof RailError) fail('payment_failed', e.message, e.status);
      throw e;
    }
    const funded = await transition(claimed, 'funded', { rail_ref: held.ref });
    await receipt('deal.funded', id, { termsHash: row.terms_hash, rail: row.rail, amount: row.amount, currency: row.currency, fundSig: signed.sig });
    if (terms.dispatch) await dispatch(funded).catch(async e => { await receipt('deal.dispatch_failed', id, { error: String(e.message).slice(0, 200) }); });
    return fullDeal(id, 'buyer'); // the caller just proved they are a party by signing
  }

  /** Hand the paid job to the seller over A2A; a seller agent answers with its signed delivery. */
  async function dispatch(row) {
    const seller = await getAgent(row.seller);
    if (!seller?.a2a) throw new Error('seller has no A2A interface');
    await receipt('deal.dispatched', row.id, { to: seller.a2a.url });
    const reply = await sendA2A(seller.a2a, { text: `Pactwire job ${row.id}: funded, please deliver`, data: { pactwire: 'job', dealId: row.id, termsHash: row.terms_hash, terms: JSON.parse(row.terms) } }, { ...fetchOpts, timeoutMs: 60000 });
    if (reply.data?.delivery) await deliver(row.id, reply.data.delivery);
    else throw new Error('seller reply carried no signed delivery');
  }

  async function deliver(id, signed) {
    const row = await loadDeal(id);
    if (row.state !== 'funded') fail('bad_state', `deal is ${row.state}; deliveries are only accepted for funded deals`, 409);
    await checkAction(signed, row, 'deliver');
    await requireSigned(signed, row.seller, 'delivery');
    const output = signed.payload.output;
    if (new TextEncoder().encode(canonical(output ?? null)).byteLength > MAX_OUTPUT_BYTES) fail('too_large', `output is limited to ${MAX_OUTPUT_BYTES} bytes`, 413);
    const outputHash = await hashJson(output ?? null);
    const late = now().getTime() > Date.parse(row.deliver_by);
    const terms = JSON.parse(row.terms);
    const verdict = late
      ? { pass: false, results: [{ index: -1, type: 'deadline', pass: false, detail: `delivered after ${row.deliver_by}` }] }
      : await runChecks(terms.acceptance, output, {
        task: terms.task,
        fetchUrl: async url => { const r = await guardedFetch(url, {}, { ...fetchOpts, maxBytes: 5_000_000 }); return { status: r.status, bytes: r.bytes }; },
        askVerifier: (check, out) => askVerifier(check, out, row, outputHash)
      });
    verdict.outputHash = outputHash;
    const rail = rails[row.rail];
    const fee = feeFor(row);
    // Claim the deal before moving money, so a second delivery cannot settle twice.
    const settling = await transition(row, 'settling', { delivery: JSON.stringify(signed), verdict: JSON.stringify(verdict) });
    try {
      if (verdict.pass) await rail.capture({ id, amount: row.amount, seller: row.seller, buyer: row.buyer, fee }, row.rail_ref);
      else await rail.release({ id, amount: row.amount, seller: row.seller, buyer: row.buyer }, row.rail_ref);
    } catch (e) {
      await transition(settling, 'funded', { delivery: null, verdict: null });
      await receipt('deal.settlement_failed', id, { termsHash: row.terms_hash, outputHash, error: String(e.message).slice(0, 200) });
      if (e instanceof RailError) fail('settlement_failed', e.message, 502);
      throw e;
    }
    await transition(settling, verdict.pass ? 'released' : 'refunded');
    await receipt('deal.delivered', id, { termsHash: row.terms_hash, outputHash, late, deliverSig: signed.sig });
    await receipt('deal.verified', id, { termsHash: row.terms_hash, outputHash, pass: verdict.pass, results: verdict.results.map(({ attestation, ...r }) => (attestation ? { ...r, attestationSig: attestation.sig, attestedBy: attestation.signer } : r)) });
    await receipt(verdict.pass ? 'deal.released' : 'deal.refunded', id, { termsHash: row.terms_hash, amount: row.amount, currency: row.currency, rail: row.rail, fee: verdict.pass ? fee : 0, paidTo: verdict.pass ? row.seller : row.buyer });
    return fullDeal(id, 'seller'); // the caller just proved they are a party by signing
  }

  async function askVerifier(check, output, row, outputHash) {
    let origin;
    try { origin = canonicalOrigin(check.agent, { allowLocal }); } catch (e) { return { pass: false, detail: `verifier: ${e.message}` }; }
    const verifier = await getAgent(origin);
    if (!verifier?.verified || !verifier.a2a) return { pass: false, detail: `verifier ${origin} is not a verified Pactwire agent` };
    if (origin === row.seller || origin === row.buyer) return { pass: false, detail: 'verifier must be independent of buyer and seller' };
    const reply = await sendA2A(verifier.a2a, { text: `Pactwire verification for ${row.id}`, data: { pactwire: 'verify', dealId: row.id, termsHash: row.terms_hash, outputHash, output, check } }, { ...fetchOpts, timeoutMs: 60000 });
    const att = reply.data?.attestation;
    if (!att || att.signer !== origin || !(await verify(att, verifier.publicJwk))) return { pass: false, detail: 'verifier reply was not a valid signed attestation' };
    const p = att.payload || {};
    if (p.action !== 'attest' || p.dealId !== row.id || p.outputHash !== outputHash) return { pass: false, detail: 'attestation is for a different deal or output' };
    return { pass: p.verdict === 'pass', detail: `verifier ${origin}: ${p.verdict}${p.reason ? ` (${String(p.reason).slice(0, 120)})` : ''}`, attestation: att };
  }

  async function cancel(id, signed) {
    const row = await loadDeal(id);
    await checkAction(signed, row, 'cancel');
    const by = signed.signer;
    if (by !== row.buyer && by !== row.seller) fail('wrong_signer', 'only the buyer or seller can cancel', 403);
    await requireSigned(signed, by, 'cancellation');
    if (row.state === 'proposed' || row.state === 'accepted') {
      await transition(row, 'cancelled');
      await receipt('deal.cancelled', id, { by, cancelSig: signed.sig });
    } else if (row.state === 'funded') {
      if (by !== row.seller) fail('bad_state', 'once funded, only the seller can cancel (the buyer is refunded); a buyer must wait for delivery or the deadline', 409);
      const claimed = await transition(row, 'settling');
      try { await rails[row.rail].release({ id, amount: row.amount, buyer: row.buyer, seller: row.seller }, row.rail_ref); }
      catch (e) { await transition(claimed, 'funded'); if (e instanceof RailError) fail('settlement_failed', e.message, 502); throw e; }
      await transition(claimed, 'refunded', { verdict: JSON.stringify({ pass: false, results: [{ index: -1, type: 'cancelled', pass: false, detail: 'seller cancelled' }] }) });
      await receipt('deal.refunded', id, { termsHash: row.terms_hash, amount: row.amount, currency: row.currency, rail: row.rail, fee: 0, paidTo: row.buyer, reason: 'seller cancelled' });
    } else fail('bad_state', `deal is ${row.state}`, 409);
    return fullDeal(id, by === row.seller ? 'seller' : 'buyer'); // the caller just proved they are a party by signing
  }

  /** Refund every funded deal whose deadline passed. Run on a schedule. */
  async function sweep() {
    const { results } = await db.prepare("SELECT * FROM deals WHERE state = 'funded' AND deliver_by < ? LIMIT 100").bind(iso()).all();
    const done = [];
    for (const row of results) {
      try {
        const claimed = await transition(row, 'settling');
        try { await rails[row.rail].release({ id: row.id, amount: row.amount, buyer: row.buyer, seller: row.seller }, row.rail_ref); }
        catch (e) { await transition(claimed, 'funded'); continue; }
        await transition(claimed, 'refunded', { verdict: JSON.stringify({ pass: false, results: [{ index: -1, type: 'deadline', pass: false, detail: 'no delivery before deadline' }] }) });
        await receipt('deal.refunded', row.id, { termsHash: row.terms_hash, amount: row.amount, currency: row.currency, rail: row.rail, fee: 0, paidTo: row.buyer, reason: 'deadline passed with no delivery' });
        done.push(row.id);
      } catch (e) { if (!(e instanceof PactwireError && e.code === 'conflict')) throw e; }
    }
    const stale = await db.prepare("SELECT * FROM deals WHERE state IN ('proposed', 'accepted') AND deliver_by < ? LIMIT 100").bind(iso()).all();
    for (const row of stale.results) {
      try { await transition(row, 'cancelled'); await receipt('deal.cancelled', row.id, { by: 'pactwire', reason: 'deadline passed before funding' }); done.push(row.id); }
      catch (e) { if (!(e instanceof PactwireError && e.code === 'conflict')) throw e; }
    }
    return done;
  }

  function feeFor(row) { return Math.floor((row.amount * feeBps) / 10000); }

  /** A card payment on a settled deal was disputed (chargeback). Recorded openly, never hidden. */
  async function recordDispute(railRef, status, disputeId) {
    const row = await db.prepare('SELECT * FROM deals WHERE rail_ref = ?').bind(railRef).first();
    if (!row) return null;
    await db.prepare('UPDATE deals SET dispute = ?, updated_at = ? WHERE id = ?').bind(String(status).slice(0, 40), iso(), row.id).run();
    await receipt('deal.disputed', row.id, { termsHash: row.terms_hash, rail: row.rail, status: String(status).slice(0, 40), disputeId: String(disputeId || '').slice(0, 80) });
    return row.id;
  }

  async function fullDeal(id, viewer) { return dealView(await loadDeal(id), await dealReceipts(db, id), { viewer }); }

  async function getDeal(id, readAuth) {
    const row = await loadDeal(id);
    const viewer = readAuth ? await canRead(readAuth, row) : 'public';
    return dealView(row, await dealReceipts(db, id), { viewer });
  }

  /** A buyer or seller proves who they are with a fresh signed { action: "read", dealId, at }. */
  async function canRead(signed, row) {
    const p = signed?.payload || {};
    if (p.action !== 'read' || p.dealId !== row.id) fail('bad_action', 'a read authorization is a signed { action: "read", dealId, at }');
    if (signed.signer !== row.buyer && signed.signer !== row.seller) fail('wrong_signer', 'only the buyer or the seller can read the delivered output', 403);
    const at = Date.parse(p.at);
    if (!Number.isFinite(at) || Math.abs(now().getTime() - at) > 300000) fail('stale_read', 'a read authorization must be signed within 5 minutes of now', 403);
    await requireSigned(signed, signed.signer, 'read authorization');
    return signed.signer === row.seller ? 'seller' : 'buyer';
  }

  async function listDeals({ party, state, limit = 50 } = {}) {
    const { results } = await db.prepare(`SELECT * FROM deals WHERE (? = '' OR buyer = ? OR seller = ?) AND (? = '' OR state = ?) ORDER BY created_at DESC LIMIT ?`)
      .bind(party || '', party || '', party || '', state || '', state || '', Math.min(limit, 200)).all();
    return results.map(r => dealView(r, null));
  }

  return { recordDispute, registerAgent, registerGuest, getAgent, listAgents, agentRecord, propose, accept, fund, deliver, cancel, sweep, getDeal, listDeals, dispatch, ACTIONS };
}

export { FetchGuardError };
