// The examples in examples/ and docs/ really run: each is started as its own process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootPactwire } from './helpers.mjs';
import { freePort } from '../src/serve.mjs';

const run = (file, env, args = []) => {
  const p = spawn(process.execPath, [fileURLToPath(new URL(`../examples/${file}`, import.meta.url)), ...args], { env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  const until = re => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${file}: timed out; output:\n${out}`)), 20000);
    const tick = () => { if (re.test(out)) { clearTimeout(t); resolve(out); } };
    p.stdout.on('data', tick); p.on('exit', () => { tick(); clearTimeout(t); re.test(out) ? resolve(out) : reject(new Error(`${file} exited:\n${out}`)); });
  });
  return { p, until };
};

test('example sellers start, verify, and get hired by the example buyer', async t => {
  const hs = await bootPactwire();
  const env = { PACTWIRE_URL: hs.base };
  const kit = run('sell-with-kit.mjs', { ...env, PORT: String(await freePort()) });
  const sdk = run('sell-from-existing-a2a-agent.mjs', { ...env, PORT: String(await freePort()) });
  t.after(() => { kit.p.kill(); sdk.p.kill(); return hs.close(); });
  assert.match(await kit.until(/READY .* verified=(true|false)/), /verified=true/);
  assert.match(await sdk.until(/READY .* verified=(true|false)/), /verified=true/);
  const b1 = await run('buy-from-code.mjs', env, ['count_words']).until(/RESULT|No verified/);
  assert.match(b1, /RESULT released \{"words":17,"sentences":3\}/);
  const b2 = await run('buy-from-code.mjs', env, ['headline']).until(/RESULT|No verified/);
  assert.match(b2, /RESULT released \{"headline":"Agents can talk and pay"\}/);
});
