#!/usr/bin/env node
// pactwire-guard: look at a paid x402 endpoint before you pay, and read what your agent's paid calls really returned.
//
//   pactwire-guard check <url>         free: read the price and what the seller promises; never pays
//   pactwire-guard report [ledger]     per endpoint and per seller: paid calls, paid-for-nothing, money wasted
//   pactwire-guard verify [ledger]     check the ledger's signatures and hash chain
//
// The default ledger is .pactwire/ledger.jsonl (what fileLedger writes in your agent).
import { readChallenge } from '../src/guard.mjs';
import { validateSchema } from '../src/checks.mjs';
import { fileLedger } from '../src/guard-file.mjs';
import { summarize, verifyLedger } from '../src/guard.mjs';

const [cmd, arg] = process.argv.slice(2);
const DEFAULT_LEDGER = '.pactwire/ledger.jsonl';
const usd = (amount) => (/^\d+$/.test(amount || '') ? `$${(Number(amount) / 1e6).toFixed(4)}` : '?');

async function check(url) {
  if (!url) throw new Error('usage: pactwire-guard check <url>');
  // A plain request with no payment header: an x402 seller answers 402 with its terms. Nothing is paid.
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status !== 402) { console.log(`${url} answered ${res.status} without payment: not an x402 paid endpoint (or it is free).`); return 0; }
  let body = null; try { body = JSON.parse(await res.text()); } catch { /* header-only */ }
  const ch = readChallenge(res.headers, body);
  if (!ch) { console.log('Answered 402 but with no readable x402 terms (no PAYMENT-REQUIRED header, no v1 body). A buyer agent could not pay this.'); return 1; }
  console.log(`x402 v${ch.x402Version}  price ${usd(ch.amount)} (USDC units ${ch.amount})  network ${ch.network}  pays ${ch.payTo}`);
  if (ch.description) console.log(`says: ${ch.description.slice(0, 200)}`);
  const { schema, example } = ch.declared;
  console.log(`declares an output schema: ${schema ? 'yes' : 'no'}; gives an example: ${example !== null ? 'yes' : 'no'}`);
  if (!schema && example === null) console.log('Nothing to hold the seller to: the guard can still catch errors and empty answers after you pay.');
  if (schema && example !== null) {
    const errs = validateSchema(schema, example);
    console.log(errs.length ? `The seller's own example breaks its own schema: ${errs.slice(0, 3).join('; ')}` : "The seller's example matches its schema.");
  }
  return 0;
}

async function report(path) {
  const rows = await (await fileLedger(path)).entries();
  const s = summarize(rows);
  if (!s.length) { console.log(`No paid calls recorded in ${path}.`); return 0; }
  for (const x of s.sort((a, b) => b.paidForNothing - a.paidForNothing)) {
    console.log(`${x.key}\n  paid calls ${x.paid}, paid for nothing ${x.paidForNothing}, warnings ${x.warnings}, spent ${usd(x.spent)}, wasted ${usd(x.wasted)}, last ${x.last}`);
  }
  return 0;
}

async function verifyCmd(path) {
  const r = await verifyLedger(await (await fileLedger(path)).entries());
  console.log(r.ok ? `${path}: ${r.count} verdicts, signatures and chain intact.` : `${path}: broken at entry ${r.at}: ${r.why}`);
  return r.ok ? 0 : 1;
}

const run = { check: () => check(arg), report: () => report(arg || DEFAULT_LEDGER), verify: () => verifyCmd(arg || DEFAULT_LEDGER) }[cmd];
if (!run) { console.log('usage: pactwire-guard check <url> | report [ledger] | verify [ledger]'); process.exit(2); }
run().then(code => process.exit(code), e => { console.error(e.message); process.exit(1); });
