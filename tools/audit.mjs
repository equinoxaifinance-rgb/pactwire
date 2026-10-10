// Audit a Pactwire service yourself, trusting only signatures.
//
//   node tools/audit.mjs <pactwire-url>                       check the whole public log
//   node tools/audit.mjs <pactwire-url> --agent <origin>      also rebuild that agent's track record and compare
//   node tools/audit.mjs <pactwire-url> --deal <deal_id>      also audit one deal
//   ... --deal <id> --identity <file.json>                     as buyer or seller: also re-run the checks on the output
//
// Exits 1 if anything does not add up.
import { readFileSync } from 'node:fs';
import { pactwireClient } from '../src/agent-kit.mjs';
import { auditLog, auditDeal, compareRecord } from '../src/audit.mjs';

const args = process.argv.slice(2);
const base = args[0]?.replace(/\/$/, '');
const opt = n => { const i = args.indexOf(`--${n}`); return i > 0 ? args[i + 1] : undefined; };
if (!base) { console.error('usage: node tools/audit.mjs <pactwire-url> [--agent <origin>] [--deal <id> [--identity <file>]]'); process.exit(2); }
const api = pactwireClient(base);
let bad = 0; const line = (pass, what) => { console.log(`${pass === null ? 'NOTE' : pass ? 'OK  ' : 'FAIL'} ${what}`); if (pass === false) bad++; };

const jwks = await api.jwks();
const receipts = []; let after = 0;
const readMore = async () => { for (;;) { const { receipts: page } = await api.log(after); if (!page.length) break; receipts.push(...page); after = page.at(-1).payload.seq; } };
await readMore();
const agent = opt('agent');
// The record is fetched after the log; if deals settled in between, read the log on to the point the record counted.
const record = agent ? await api.record(agent) : null;
if (record && (record.payload.logSeq || 0) > after) await readMore();
const audit = await auditLog(receipts, jwks);
line(audit.chain.ok, `public log: ${audit.chain.count} receipts; every signature and link checked${audit.chain.ok ? '' : `: ${audit.chain.problems.slice(0, 3).join('; ')}`}`);
line(null, `${audit.keys.size} agents and ${audit.deals.size} deals in the log`);

if (agent) {
  const cmp = await compareRecord(record, audit, jwks);
  line(cmp.ok, `track record of ${agent} matches the log${cmp.ok ? '' : `: ${cmp.problems.join('; ')}`}`);
  const r = cmp.fromLog;
  line(null, `from the log: real money ${r.real.seller.passed} passed / ${r.real.seller.failedOrLate} failed; play money ${r.sandbox.seller.passed} passed / ${r.sandbox.seller.failedOrLate} failed`);
}
const dealId = opt('deal');
if (dealId) {
  const idFile = opt('identity');
  const identity = idFile ? JSON.parse(readFileSync(idFile, 'utf8')) : undefined;
  const result = await auditDeal(await api.deal(dealId, identity), audit);
  console.log(`\nDeal ${dealId} (${result.state}):`);
  for (const f of result.findings) line(f.pass, f.what);
}
console.log(bad ? `\n${bad} problem(s) found.` : '\nEverything checked out.');
process.exit(bad ? 1 : 0);
