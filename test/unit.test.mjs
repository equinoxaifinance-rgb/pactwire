import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, sign, verify, generateKeyPair, hashJson } from '../src/crypto.mjs';
import { runChecks, validateChecks, validateSchema, getPath } from '../src/checks.mjs';
import { assertFetchable, isPrivateAddress } from '../src/a2a-client.mjs';

test('canonical JSON is stable and matches RFC 8785 for common values', () => {
  assert.equal(canonical({ b: 1, a: [true, null, 'x'], c: { z: 0, y: -0 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}');
  assert.equal(canonical({ 'é': 1, e: 2 }), '{"e":2,"é":1}');
  assert.equal(canonical({ a: undefined, b: 1 }), '{"b":1}');
  assert.throws(() => canonical({ n: NaN }));
});

test('signatures fail after any change to payload, signer key or signature', async () => {
  const k = await generateKeyPair(); const other = await generateKeyPair();
  const s = await sign({ action: 'deliver', output: { n: 1 } }, 'https://a.example', k.privateJwk);
  assert.equal(await verify(s, k.publicJwk), true);
  assert.equal(await verify({ ...s, payload: { ...s.payload, output: { n: 2 } } }, k.publicJwk), false);
  assert.equal(await verify(s, other.publicJwk), false);
  const flipped = s.sig.slice(0, 10) + (s.sig[10] === 'A' ? 'B' : 'A') + s.sig.slice(11);
  assert.equal(await verify({ ...s, sig: flipped }, k.publicJwk), false);
  assert.equal(await verify({ payload: {}, sig: 'x' }, { kty: 'RSA' }), false);
  assert.equal(await hashJson({ a: 1, b: 2 }), await hashJson({ b: 2, a: 1 }));
});

test('checks: pass, fail and refuse dangerous definitions', async () => {
  const out = { title: 'Escrow facts', facts: ['a', 'b'], meta: { lang: 'en' } };
  const r = await runChecks([
    { type: 'json_schema', schema: { type: 'object', required: ['title'], properties: { facts: { type: 'array', minItems: 2, items: { type: 'string' } } } } },
    { type: 'field_equals', path: 'meta.lang', value: 'en' },
    { type: 'field_matches', path: 'title', pattern: '^Escrow' },
    { type: 'contains_text', text: 'ESCROW' },
    { type: 'count_at_least', path: 'facts', min: 2 },
    { type: 'sha256', path: 'facts[0]', equals: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' }
  ], out);
  assert.equal(r.pass, true, JSON.stringify(r.results));
  const f = await runChecks([{ type: 'count_at_least', path: 'facts', min: 3 }], out);
  assert.equal(f.pass, false);
  assert.throws(() => validateChecks([{ type: 'field_matches', path: 'x', pattern: '(a+)+$' }]), /nested/);
  assert.throws(() => validateChecks([{ type: 'nope' }]), /unknown check/);
  assert.throws(() => validateChecks([]), /non-empty/);
  assert.equal(getPath({ a: 1 }, '__proto__'), undefined);
  assert.deepEqual(validateSchema({ type: 'object', additionalProperties: false, properties: { a: {} } }, { a: 1, b: 2 }), ['$: unexpected property b']);
  const u = await runChecks([{ type: 'url_content_hash', urlPath: 'u', hashPath: 'h' }], { u: 'https://x.example', h: '00' }, { fetchUrl: async () => { throw new Error('ECONNREFUSED 10.0.0.1'); } });
  assert.equal(u.pass, false);
  assert.doesNotMatch(u.results[0].detail, /10\.0|ECONN|HTTP/, 'url check leaks nothing about the target');
});

test('outbound fetch guard blocks private targets but not ordinary names', () => {
  for (const bad of ['http://example.com', 'https://127.0.0.1', 'https://10.1.2.3', 'https://[::1]', 'https://[fd00::1]', 'https://169.254.169.254', 'https://localhost', 'https://x.internal', 'https://u:p@example.com', 'https://2130706433', 'https://[::ffff:127.0.0.1]'])
    assert.throws(() => assertFetchable(bad), undefined, bad);
  for (const good of ['https://example.com', 'https://fd.example.com', 'https://fc-agent.io', 'https://8.8.8.8']) assert.doesNotThrow(() => assertFetchable(good), good);
  assert.doesNotThrow(() => assertFetchable('http://127.0.0.1:8080', { allowLocal: true }));
  assert.equal(isPrivateAddress('192.168.1.1'), true);
  assert.equal(isPrivateAddress('1.1.1.1'), false);
  assert.equal(isPrivateAddress('2606:4700::1111'), false);
});

test('richer checks: ranges, words, dates, uniqueness, grounding, per-item and logic', async () => {
  const source = 'Escrow holds the money until the work is checked. Receipts are signed. The log is public.';
  const out = { score: 7, summary: 'Escrow holds money until work passes the checks.', published: '2026-10-01',
    items: [{ id: 'a', price: 5, note: 'Escrow holds the money' }, { id: 'b', price: 9, note: 'Receipts are signed.' }],
    quotes: ['escrow holds the money until the work is checked', 'The log is “public”.'] };
  const good = [
    { type: 'number_between', path: 'score', min: 0, max: 10 },
    { type: 'word_count', path: 'summary', min: 5, max: 12 },
    { type: 'date_between', path: 'published', after: '2026-01-01', before: '2026-12-31' },
    { type: 'unique_by', path: 'items', key: 'id' },
    { type: 'quotes_in_source', path: 'quotes', sourceTaskPath: 'source' },
    { type: 'each', path: 'items', minItems: 2, checks: [{ type: 'number_between', path: 'price', min: 1, max: 10 }, { type: 'quotes_in_source', path: 'note', source }] },
    { type: 'any_of', checks: [{ type: 'field_equals', path: 'score', value: 99 }, { type: 'contains_text', text: 'escrow' }] },
    { type: 'not', check: { type: 'contains_text', text: 'guaranteed' } },
    { type: 'all_of', checks: [{ type: 'max_bytes', bytes: 2000 }, { type: 'count_at_least', path: 'quotes', min: 2 }] }
  ];
  validateChecks(good);
  const r = await runChecks(good, out, { task: { source } });
  assert.equal(r.pass, true, JSON.stringify(r.results.filter(x => !x.pass)));
  const bad = { ...out, score: 11, quotes: ['escrow holds everything forever'], items: [out.items[0], { ...out.items[1], id: 'a' }], summary: 'Guaranteed returns.' };
  const rb = await runChecks(good, bad, { task: { source } });
  assert.deepEqual(rb.results.map(x => x.pass), [false, false, true, false, false, true, true, false, false]); // last: only one quote now
  // Quoting a single common word from the source is not enough.
  assert.equal((await runChecks([{ type: 'quotes_in_source', path: 'q', source }], { q: ['the'] })).pass, false);
  // Network checks cannot hide inside groups, and nesting is bounded.
  assert.throws(() => validateChecks([{ type: 'each', path: 'x', checks: [{ type: 'verifier_agent', agent: 'https://v.example' }] }]), /cannot be used inside/);
  let deep = { type: 'contains_text', text: 'x' }; for (let i = 0; i < 5; i++) deep = { type: 'not', check: deep };
  assert.throws(() => validateChecks([deep]), /nested at most/);
  assert.throws(() => validateChecks([{ type: 'number_between', path: 'x' }]), /min and\/or max/);
  assert.throws(() => validateChecks([{ type: 'all_of', checks: Array.from({ length: 70 }, () => ({ type: 'max_bytes', bytes: 1 })) }]), /in total/);
});
