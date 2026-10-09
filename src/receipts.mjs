// The public receipt log: every step of every deal becomes a receipt signed by
// the Pactwire service and chained to the one before it (each receipt holds the
// hash of the previous one). Anyone can download the log and check, offline,
// that nothing was edited, removed or reordered, using only the public key.

import { sign, verify, hashJson, canonical } from './crypto.mjs';

export const GENESIS = '0'.repeat(64);

export async function appendReceipt(db, service, { dealId = null, kind, data }) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const head = await db.prepare('SELECT seq, hash FROM receipts ORDER BY seq DESC LIMIT 1').first();
    const seq = (head?.seq || 0) + 1;
    const prevHash = head?.hash || GENESIS;
    const payload = { v: 'pactwire-receipt/1', seq, prevHash, at: new Date().toISOString(), kind, dealId, data };
    const signed = await sign(payload, service.id, service.privateJwk);
    signed.kid = service.kid;
    const hash = await hashJson(signed);
    try {
      await db.prepare('INSERT INTO receipts (seq, deal_id, kind, prev_hash, hash, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(seq, dealId, kind, prevHash, hash, JSON.stringify(signed), payload.at).run();
      return { ...signed, hash };
    } catch (e) {
      if (!/UNIQUE|constraint/i.test(String(e?.message))) throw e; // another writer took this slot: retry on the new head
    }
  }
  throw new Error('receipt log busy, retry');
}

export async function readLog(db, { after = 0, limit = 100 } = {}) {
  const { results } = await db.prepare('SELECT body, hash FROM receipts WHERE seq > ? ORDER BY seq ASC LIMIT ?').bind(after, Math.min(Math.max(limit, 1), 500)).all();
  return results.map(r => ({ ...JSON.parse(r.body), hash: r.hash }));
}

export async function dealReceipts(db, dealId) {
  const { results } = await db.prepare('SELECT body, hash FROM receipts WHERE deal_id = ? ORDER BY seq ASC').bind(dealId).all();
  return results.map(r => ({ ...JSON.parse(r.body), hash: r.hash }));
}

/**
 * Verify a run of receipts offline. Pass the service public key (from /.well-known/jwks.json).
 * If `from` is the first receipt of the log (seq 1) the chain is checked from genesis.
 */
// Accepts one key or a JWKS-style list ({ keys: [...] } or [...]); each receipt is checked
// with the key whose kid it names, so receipts signed before a key rotation still verify.
function keyFor(receipt, keys) {
  const list = Array.isArray(keys) ? keys : Array.isArray(keys?.keys) ? keys.keys : [keys];
  return list.find(k => k?.kid && k.kid === receipt.kid) || (list.length === 1 ? list[0] : null);
}

export async function verifyChain(receipts, publicJwk, { expectStartPrev } = {}) {
  const problems = [];
  let prev = expectStartPrev ?? (receipts[0]?.payload?.seq === 1 ? GENESIS : receipts[0]?.payload?.prevHash);
  for (const r of receipts) {
    const { hash, ...signed } = r;
    const key = keyFor(r, publicJwk);
    if (!key || !(await verify(signed, key))) problems.push(`seq ${r.payload?.seq}: bad signature${key ? '' : ' (unknown key id)'}`);
    const recomputed = await hashJson(signed);
    if (hash && recomputed !== hash) problems.push(`seq ${r.payload?.seq}: hash mismatch`);
    if (r.payload?.prevHash !== prev) problems.push(`seq ${r.payload?.seq}: chain broken (prevHash does not match)`);
    prev = recomputed;
  }
  return { ok: problems.length === 0, problems, head: prev, count: receipts.length };
}

/** Verify a single receipt's signature (without the chain). */
export async function verifyReceipt(receipt, publicJwk) {
  const { hash, ...signed } = receipt;
  const key = keyFor(receipt, publicJwk);
  const sigOk = !!key && await verify(signed, key);
  const hashOk = !hash || (await hashJson(signed)) === hash;
  return { ok: sigOk && hashOk, sigOk, hashOk };
}

export { canonical };
