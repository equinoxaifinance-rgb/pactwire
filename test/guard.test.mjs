// The guard under the real x402 client (@x402/fetch), against a local seller that settles and then
// misbehaves in the ways public trackers report: 500 after settling, empty results, off-schema JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { createGuard, memoryLedger, verifyLedger, readChallenge, declaredOutput, judgeResponse, GuardBlockedError } from '../src/guard.mjs';
import { fileLedger, fileKey } from '../src/guard-file.mjs';

const NET = 'eip155:84532';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const example = { query: 'x402', results: [{ title: 'x402 spec', url: 'https://example.com/spec' }] };
const outSchema = { properties: { query: { type: 'string' }, results: { type: 'array', items: { type: 'object', required: ['title', 'url'] } } }, required: ['query', 'results'] };

function seller() {
  let paidCalls = 0;
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const payTo = path.startsWith('/other') ? OTHER : PAY_TO;
    if (!req.headers['payment-signature']) {
      const pr = {
        x402Version: 2, error: 'payment required',
        resource: { url: `http://${req.headers.host}${path}`, description: 'web search', mimeType: 'application/json' },
        accepts: [{ scheme: 'exact', network: NET, asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' /* USDC on Base Sepolia */, amount: '7000', payTo, maxTimeoutSeconds: 60, extra: {} }],
        extensions: path.includes('noschema') ? {} : declareDiscoveryExtension({ input: { q: 'x402' }, output: { example, schema: outSchema } }),
      };
      res.writeHead(402, { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(pr), 'content-type': 'application/json' });
      return res.end('{}');
    }
    paidCalls++;
    const settled = { 'PAYMENT-RESPONSE': encodePaymentResponseHeader({ success: true, transaction: `0xtx${paidCalls}`, network: NET, payer: '0xbuyer' }) };
    const json = (status, body, extra = settled) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (path.endsWith('/good') || path.endsWith('/noschema')) return json(200, example);
    if (path.endsWith('/broken')) return json(500, '');
    if (path.endsWith('/empty')) return json(200, { query: 'x402', results: [] });
    if (path.endsWith('/offschema')) return json(200, { answer: 'trust me' });
    if (path.endsWith('/unsettled-error')) return json(503, { error: 'upstream down' }, {});
    return json(404, '');
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}`, paid: () => paidCalls })));
}

// A stand-in payment scheme: the real client calls it to make the payment header. No money, no chain.
const fakeScheme = { scheme: 'exact', createPaymentPayload: async (x402Version) => ({ x402Version, payload: { signature: '0xfake' } }) };
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const payer = guard => wrapFetchWithPayment(guard.fetch, x402Client.fromConfig({ schemes: [{ network: NET, client: fakeScheme }], spendControls: { allowedAssets: [{ network: NET, asset: ASSET }] } }));

test('guard reads the Bazaar declaration the official SDK writes', () => {
  const ext = declareDiscoveryExtension({ input: { q: 'x' }, output: { example, schema: outSchema } });
  const d = declaredOutput({ x402Version: 2, extensions: ext });
  assert.deepEqual(d.example, example);
  assert.deepEqual(d.schema.required, ['query', 'results']);
  // An example with no schema only gets the SDK's default { type: "object" }: not treated as a declaration.
  const bare = declaredOutput({ x402Version: 2, extensions: declareDiscoveryExtension({ input: {}, output: { example } }) });
  assert.equal(bare.schema, null); assert.deepEqual(bare.example, example);
  // v1 puts an example at accepts[0].outputSchema.output
  const v1 = readChallenge(new Headers(), { x402Version: 1, accepts: [{ maxAmountRequired: '10', payTo: PAY_TO, network: 'base', outputSchema: { input: {}, output: { a: 1 } } }] });
  assert.equal(v1.amount, '10'); assert.deepEqual(v1.declared.example, { a: 1 });
});

test('a good paid answer passes and is recorded with its transaction', async () => {
  const { server, base } = await seller();
  try {
    const guard = createGuard();
    const res = await payer(guard)(`${base}/good?q=x402`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), example, 'the caller still gets the full body');
    const v = guard.verdictFor(res);
    assert.equal(v.ok, true); assert.equal(v.paid, 'yes'); assert.equal(v.transaction, '0xtx1'); assert.equal(v.payTo, PAY_TO);
    assert.deepEqual(v.problems, []);
  } finally { server.close(); }
});

test('settled-then-500, empty results and off-schema JSON are caught; the endpoint is refused before paying again', async () => {
  const { server, base, paid } = await seller();
  try {
    const guard = createGuard();
    const pay = payer(guard);
    const r1 = await pay(`${base}/broken`);
    const v1 = guard.verdictFor(r1);
    assert.equal(v1.paidForNothing, true);
    assert.deepEqual(v1.problems.map(p => p.code), ['http_error', 'empty_body']);
    const v2 = guard.verdictFor(await pay(`${base}/broken`));
    assert.equal(v2.paidForNothing, true);
    const before = paid();
    await assert.rejects(pay(`${base}/broken`), e => e instanceof GuardBlockedError && /charged for nothing 2 times/.test(e.message));
    assert.equal(paid(), before, 'no payment was sent for the refused call');
    // Other endpoints of the same seller still work until the seller-wide limit.
    const ve = guard.verdictFor(await pay(`${base}/empty`));
    assert.equal(ve.ok, true, 'empty list matches the schema, so it is a warning, not a failure');
    assert.deepEqual(ve.problems.map(p => p.code), ['empty_list']);
    const vo = guard.verdictFor(await pay(`${base}/offschema`));
    assert.equal(vo.paidForNothing, true);
    assert.match(vo.problems[0].detail, /missing query/);
    // 3 paid-for-nothing from one payTo: the whole seller is refused, even an endpoint we never called.
    await assert.rejects(pay(`${base}/good`), /seller 0x1111.* charged for nothing 3 times/);
    // A different seller is unaffected.
    assert.equal(guard.verdictFor(await pay(`${base}/other/good`)).ok, true);
    // Unblocking lets the buyer try again; only new failures count.
    await guard.unblock({ payTo: PAY_TO }); await guard.unblock(`${base}/broken`);
    assert.equal(guard.verdictFor(await pay(`${base}/good`)).ok, true);
    const rep = await guard.report();
    const s = rep.find(x => x.key === `seller:${PAY_TO}`);
    assert.equal(s.paidForNothing, 3); assert.equal(s.wasted, '21000');
  } finally { server.close(); }
});

test('an error with no settlement header is recorded as likely paid, a free endpoint is not judged', async () => {
  const { server, base } = await seller();
  try {
    const guard = createGuard();
    const v = guard.verdictFor(await payer(guard)(`${base}/unsettled-error`));
    assert.equal(v.paid, 'likely'); assert.equal(v.ok, false); assert.equal(v.paidForNothing, true);
    const free = await guard.fetch(`${base}/missing`, { headers: { 'payment-signature': 'x' } });
    assert.equal(free.status, 404);
  } finally { server.close(); }
});

test('the buyer\'s own Pactwire checks run on every paid answer', async () => {
  const { server, base } = await seller();
  try {
    const guard = createGuard({ checks: [{ type: 'count_at_least', path: 'results', min: 3 }] });
    const v = guard.verdictFor(await payer(guard)(`${base}/noschema`));
    assert.equal(v.ok, false);
    assert.match(v.problems.find(p => p.code === 'check_failed').detail, /1 items/);
  } finally { server.close(); }
});

test('verdicts form a signed hash chain on disk that detects edits, and survive a restart', async () => {
  const { server, base } = await seller();
  const dir = await mkdtemp(join(tmpdir(), 'guard-'));
  try {
    const key = await fileKey(join(dir, 'key.json'));
    const g1 = createGuard({ key, ledger: await fileLedger(join(dir, 'ledger.jsonl')) });
    await payer(g1)(`${base}/broken`); await payer(g1)(`${base}/good`);
    // Restart: a new guard on the same files remembers the failure.
    const g2 = createGuard({ key: await fileKey(join(dir, 'key.json')), ledger: await fileLedger(join(dir, 'ledger.jsonl')) });
    await payer(g2)(`${base}/broken`);
    await assert.rejects(payer(g2)(`${base}/broken`), GuardBlockedError);
    const rows = (await readFile(join(dir, 'ledger.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(rows.length, 3);
    assert.deepEqual(await verifyLedger(rows), { ok: true, count: 3 });
    const tampered = structuredClone(rows); tampered[0].payload.paidForNothing = false;
    assert.equal((await verifyLedger(tampered)).ok, false);
    const dropped = [rows[0], rows[2]];
    assert.equal((await verifyLedger(dropped)).why, 'chain broken');
  } finally { server.close(); }
});

test('judgeResponse on its own: error-in-body warning and guard.check for non-x402 calls', async () => {
  const w = await judgeResponse({ status: 200, contentType: 'application/json', bodyText: '{"error":"rate limited"}' });
  assert.equal(w.ok, true); assert.equal(w.problems[0].code, 'error_in_body');
  const guard = createGuard({ ledger: memoryLedger() });
  const v = await guard.check({ resource: 'https://api.example.com/v1/enrich?x=1', body: {}, amount: '150000', payTo: 'acct_1' });
  assert.equal(v.paidForNothing, true); assert.equal(v.problems[0].code, 'empty_result');
  assert.equal(v.receipt.payload.resource, 'https://api.example.com/v1/enrich');
});

test('the CLI reads a seller\'s terms for free and reports a ledger', async () => {
  const { execFile } = await import('node:child_process');
  const cli = (...args) => new Promise(r => execFile(process.execPath, ['bin/pactwire-guard.mjs', ...args], (err, stdout) => r({ code: err?.code ?? 0, out: stdout })));
  const { server, base, paid } = await seller();
  const dir = await mkdtemp(join(tmpdir(), 'guard-cli-'));
  try {
    const c = await cli('check', `${base}/good`);
    assert.equal(c.code, 0);
    assert.match(c.out, /price \$0\.0070/); assert.match(c.out, /declares an output schema: yes; gives an example: yes/); assert.match(c.out, /example matches its schema/);
    assert.equal(paid(), 0, 'check never pays');
    const g = createGuard({ ledger: await fileLedger(join(dir, 'l.jsonl')) });
    await payer(g)(`${base}/broken`);
    const r = await cli('report', join(dir, 'l.jsonl'));
    assert.match(r.out, /paid for nothing 1/); assert.match(r.out, /wasted \$0\.0070/);
    assert.match((await cli('verify', join(dir, 'l.jsonl'))).out, /1 verdicts, signatures and chain intact/);
  } finally { server.close(); }
});
