// Payment rails: where the money for a deal is held, then paid out or returned.
// Every rail does the same three things:
//   hold(deal, funding)   -> { ref, status: 'held' }       money is set aside, nobody has it yet
//   capture(deal, ref)    -> { status: 'captured' }        work passed: seller is paid
//   release(deal, ref)    -> { status: 'released' }        work failed or late: buyer keeps the money
//
// Rails here:
//   sandbox  - built-in credit ledger (free play money) for trying Pactwire end to end.
//   stripe   - real cards: a Stripe PaymentIntent with manual capture (an authorization hold),
//              captured only when the checks pass, cancelled otherwise. The seller is paid directly
//              to its Stripe Connect account; Pactwire's fee is application_fee_amount.

export class RailError extends Error {
  constructor(message, status = 402) { super(message); this.status = status; }
}

export function sandboxRail(db) {
  const now = () => new Date().toISOString();
  return {
    name: 'sandbox',
    maxHoldDays: 30,
    async balance(account) {
      const row = await db.prepare('SELECT balance FROM ledger_accounts WHERE id = ?').bind(account).first();
      return row?.balance || 0;
    },
    async credit(account, amount) {
      await db.prepare('INSERT INTO ledger_accounts (id, balance, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at').bind(account, amount, now()).run();
      return this.balance(account);
    },
    async hold(deal) {
      // Record the hold first (one per deal), then debit only if the balance covers it.
      const ref = `hold_${deal.id}`;
      const ins = await db.prepare("INSERT INTO ledger_holds (id, deal_id, payer, payee, amount, status, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT(deal_id) DO NOTHING").bind(ref, deal.id, deal.buyer, deal.seller, deal.amount, now()).run();
      if (!ins.meta?.changes) throw new RailError('this deal already has a hold', 409);
      const r = await db.prepare('UPDATE ledger_accounts SET balance = balance - ?, updated_at = ? WHERE id = ? AND balance >= ?').bind(deal.amount, now(), deal.buyer, deal.amount).run();
      if (!r.meta?.changes) {
        await db.prepare("DELETE FROM ledger_holds WHERE id = ? AND status = 'pending'").bind(ref).run();
        throw new RailError('insufficient sandbox balance; call POST /v1/sandbox/faucet first');
      }
      await db.prepare("UPDATE ledger_holds SET status = 'held', updated_at = ? WHERE id = ?").bind(now(), ref).run();
      return { ref, status: 'held' };
    },
    async capture(deal, ref) {
      const r = await db.prepare("UPDATE ledger_holds SET status = 'captured', updated_at = ? WHERE id = ? AND status = 'held'").bind(now(), ref).run();
      if (!r.meta?.changes) throw new RailError('hold is not open', 409);
      const fee = Math.max(0, Math.min(deal.fee || 0, deal.amount));
      await this.credit(deal.seller, deal.amount - fee);
      if (fee) await this.credit('pactwire:fees', fee);
      return { status: 'captured' };
    },
    async release(deal, ref) {
      const r = await db.prepare("UPDATE ledger_holds SET status = 'released', updated_at = ? WHERE id = ? AND status = 'held'").bind(now(), ref).run();
      if (!r.meta?.changes) throw new RailError('hold is not open', 409);
      await this.credit(deal.buyer, deal.amount);
      return { status: 'released' };
    }
  };
}

/**
 * Stripe rail. Card authorizations are held for up to 7 days by most card networks,
 * so deals on this rail must be delivered within 6 days.
 * funding: { payment_method: 'pm_...', customer?: 'cus_...' } supplied by the buyer's principal.
 * seller connected account: deal.payout?.stripeAccount ('acct_...') if the seller onboarded with Connect.
 */
export function stripeRail({ secretKey, apiBase = 'https://api.stripe.com', fetchImpl = fetch }) {
  if (!secretKey) throw new Error('stripe rail needs secretKey');
  const call = async (path, params, idempotencyKey) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) body.set(k, String(v));
    const r = await fetchImpl(`${apiBase}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2025-08-27.basil', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
      body
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new RailError(`stripe: ${json?.error?.message || `HTTP ${r.status}`}`.slice(0, 300), r.status === 402 ? 402 : 502);
    return json;
  };
  return {
    name: 'stripe',
    maxHoldDays: 6,
    async hold(deal, funding = {}) {
      if (!/^pm_[A-Za-z0-9_]+$/.test(funding.payment_method || '')) throw new RailError('stripe funding needs payment_method (pm_...)', 400);
      if (funding.customer && !/^cus_[A-Za-z0-9_]+$/.test(funding.customer)) throw new RailError('customer must be cus_...', 400);
      const fee = Math.max(0, Math.min(deal.fee || 0, deal.amount));
      const dest = deal.payout?.stripeAccount;
      if (!/^acct_[A-Za-z0-9]+$/.test(dest || '')) throw new RailError('stripe deals need the seller\'s Connect account in terms.payout.stripeAccount', 400);
      const pi = await call('/v1/payment_intents', {
        amount: deal.amount, currency: deal.currency, capture_method: 'manual', confirm: 'true',
        payment_method: funding.payment_method, customer: funding.customer, off_session: funding.customer ? 'true' : undefined,
        'payment_method_types[]': 'card',
        description: `Pactwire deal ${deal.id}`.slice(0, 200),
        'metadata[pactwire_deal]': deal.id, 'metadata[terms_hash]': deal.terms_hash,
        'transfer_data[destination]': dest, application_fee_amount: fee || undefined
      }, `hs-hold-${deal.id}`);
      if (pi.status !== 'requires_capture' && !this.acceptAnyStatus) throw new RailError(`card was not authorized (status ${pi.status})`);
      return { ref: pi.id, status: 'held' };
    },
    async capture(deal, ref) {
      await call(`/v1/payment_intents/${encodeURIComponent(ref)}/capture`, {}, `hs-capture-${deal.id}`);
      return { status: 'captured' };
    },
    async release(deal, ref) {
      await call(`/v1/payment_intents/${encodeURIComponent(ref)}/cancel`, { cancellation_reason: 'abandoned' }, `hs-cancel-${deal.id}`);
      return { status: 'released' };
    }
  };
}

/**
 * Verify a Stripe webhook (Stripe-Signature: t=<unix>,v1=<hex hmac-sha256 of "t.body">).
 * Returns the parsed event or throws.
 */
export async function verifyStripeWebhook(rawBody, header, secret, { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const parts = Object.fromEntries(String(header || '').split(',').map(kv => kv.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header || '').split(',').filter(p => p.trim().startsWith('v1=')).map(p => p.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) throw new RailError('missing Stripe signature', 400);
  if (Math.abs(nowSec - t) > toleranceSec) throw new RailError('Stripe signature too old', 400);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`)));
  const hex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  const same = (a, b) => a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
  if (!sigs.some(s => same(s, hex))) throw new RailError('bad Stripe signature', 400);
  return JSON.parse(rawBody);
}
