// One command to put Pactwire (sandbox mode) and the three practice agents live on Cloudflare,
// then prove it works with a real deal. Needs: `npx wrangler login` done once on this machine.
//
//   node tools/deploy.mjs            do it
//   node tools/deploy.mjs --plan     print what it would do, change nothing
//
// It keeps the generated keys in .data/deploy-keys.json (git-ignored). Never commit that file.
// Running it again is safe: it reuses the database and keys and redeploys.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPair } from '../src/crypto.mjs';

const plan = process.argv.includes('--plan');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = (args, input) => {
  console.log(`$ npx ${args.join(' ')}`);
  if (plan) return '';
  // stdin is always a pipe, so wrangler never stops to ask a question halfway through.
  return execFileSync(npx, args, { encoding: 'utf8', input: input ?? '', stdio: ['pipe', 'pipe', 'inherit'], shell: process.platform === 'win32' });
};

mkdirSync('.data', { recursive: true });
const keyFile = '.data/deploy-keys.json';
const keys = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')) : {};
for (const k of ['service', 'writer', 'cutter', 'checker']) keys[k] ||= (await generateKeyPair()).privateJwk;
if (!plan) writeFileSync(keyFile, JSON.stringify(keys, null, 2), { mode: 0o600 });

// 1. D1 database
let dbId = '';
const list = run(['wrangler', 'd1', 'list', '--json']);
if (!plan) dbId = (JSON.parse(list || '[]').find(d => d.name === 'pactwire') || {}).uuid || '';
if (!dbId) {
  const out = run(['wrangler', 'd1', 'create', 'pactwire']);
  dbId = (out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [''])[0];
  if (!plan && !dbId) throw new Error('could not read the new D1 database id from wrangler output');
}
if (!plan) writeFileSync('wrangler.jsonc', readFileSync('wrangler.jsonc', 'utf8').replace(/"database_id": "[^"]*"/, `"database_id": "${dbId}"`));
run(['wrangler', 'd1', 'migrations', 'apply', 'pactwire', '--remote']);

// 2. Deploy Pactwire once to learn this account's workers.dev address
const first = run(['wrangler', 'deploy']);
const url = plan ? 'https://pactwire.YOUR-SUBDOMAIN.workers.dev' : (first.match(/https:\/\/pactwire\.[a-z0-9-]+\.workers\.dev/) || [''])[0];
if (!url) throw new Error('could not find the workers.dev URL in the deploy output');
const sub = url.replace('https://pactwire.', '');
run(['wrangler', 'secret', 'put', 'PACTWIRE_PRIVATE_JWK'], JSON.stringify(keys.service));
run(['wrangler', 'deploy', '--var', `BASE_URL:${url}`]);

// 3. Practice agents
const agents = { writer: 'pactwire-fact-writer', cutter: 'pactwire-corner-cutter', checker: 'pactwire-checker' };
const origins = {};
for (const [env, name] of Object.entries(agents)) {
  origins[env] = `https://${name}.${sub}`;
  run(['wrangler', 'deploy', '-c', 'wrangler.demo-agents.jsonc', '--env', env, '--var', `ORIGIN:${origins[env]}`]);
  run(['wrangler', 'secret', 'put', 'AGENT_PRIVATE_JWK', '-c', 'wrangler.demo-agents.jsonc', '--env', env], JSON.stringify(keys[env]));
}

// 4. Prove it with a real deal against the live services
console.log('\nLive check:');
const args = ['tools/try-deal.mjs', url, origins.writer, origins.cutter, origins.checker];
console.log(`$ node ${args.join(' ')}`);
if (!plan && !process.env.DEPLOY_REHEARSAL) execFileSync(process.execPath, args, { stdio: 'inherit' });
// 5. Audit the live log from the outside, trusting only signatures
const audit = ['tools/audit.mjs', url, '--agent', origins.writer];
console.log(`$ node ${audit.join(' ')}`);
if (!plan && !process.env.DEPLOY_REHEARSAL) execFileSync(process.execPath, audit, { stdio: 'inherit' });
if (!plan) writeFileSync('.data/deploy-result.json', JSON.stringify({ url, origins, at: new Date().toISOString() }, null, 2));
console.log(`\nPactwire: ${url}\nAgent card: ${url}/.well-known/agent-card.json\nMCP: ${url}/mcp\nPractice agents: ${Object.values(origins).join(', ')}`);
