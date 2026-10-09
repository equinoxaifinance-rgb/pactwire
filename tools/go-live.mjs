// Pactwire go-live, in one command, from a machine where `npx wrangler login` and `gh auth login` are done:
//   node tools/go-live.mjs            deploy the play-money sandbox, prove it live, then publish the code
//   node tools/go-live.mjs --deploy-only
//
// Each step runs only if the one before it passed:
//   1. tests here (JS; Python too if python3 and `cryptography` are installed)
//   2. tools/deploy.mjs: database, keys, Pactwire and three practice agents on Cloudflare, a real
//      deal against the live services, and an outside audit of the live log
//   3. tools/export-public.mjs: clean copy with no private history, after the leak check
//   4. tests again inside the clean copy
//   5. public GitHub repo, npm package (if `npm whoami` works) and MCP Registry (if mcp-publisher is installed)
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const win = process.platform === 'win32';
// npm is a .cmd script on Windows and needs a shell (its arguments here never contain spaces);
// git, gh and mcp-publisher are real programs and run without one, so arguments with spaces stay intact.
const SHELL = new Set(['npm']);
const sh = (cmd, args, opts = {}) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', shell: win && SHELL.has(cmd), ...opts });
};
const has = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', shell: win && SHELL.has(cmd) }).status === 0;
const step = t => console.log(`\n==== ${t} ====`);

step('1. Tests');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) { console.error(`Node ${process.versions.node} is too old: Pactwire's local database needs Node 22.5 or newer.`); process.exit(1); }
sh('npm', ['test']);
const py = ['python3', 'python', 'py'].find(p => has(p, ['-c', 'import cryptography']));
if (py) sh(py, ['kits/python/test_interop.py']);
else console.log('(python3 with cryptography not found; Python tests skipped here, they ran before shipping)');

step('2. Deploy the play-money sandbox and prove it live');
sh(process.execPath, ['tools/deploy.mjs']);
const { url } = JSON.parse(readFileSync('.data/deploy-result.json', 'utf8'));
if (process.argv.includes('--deploy-only')) { console.log(`\nLive: ${url}`); process.exit(0); }

step('3. Clean public copy');
// Outside the private workspace clone, so the public repo never sits inside the private one.
const out = resolve('..', '..', 'pactwire-public');
if (existsSync(out)) { console.error(`${out} already exists; move it away and run again`); process.exit(1); }
sh(process.execPath, ['tools/export-public.mjs', out, '--sandbox-url', url]);
const reg = join(out, 'registry/server.json');
writeFileSync(reg, readFileSync(reg, 'utf8').replaceAll('https://pactwire.REPLACE.workers.dev', url));

step('4. Tests inside the clean copy');
sh('npm', ['ci'], { cwd: out });
sh('npm', ['test'], { cwd: out });

step('5. Publish');
sh('git', ['init', '-b', 'main'], { cwd: out });
sh('git', ['add', '-A'], { cwd: out });
sh('git', ['-c', 'user.name=Pactwire authors', '-c', 'user.email=noreply@users.noreply.github.com', 'commit', '-m', 'Pactwire 0.1.0: escrow and proof for paid jobs between AI agents'], { cwd: out });
sh('gh', ['repo', 'create', 'equinoxaifinance-rgb/pactwire', '--public', '--source', '.', '--push', '--description', 'Escrow and proof for paid jobs between AI agents. Money is held until the work passes checks both agents signed. A2A + MCP.', '--homepage', url], { cwd: out });
sh('gh', ['repo', 'edit', 'equinoxaifinance-rgb/pactwire', '--add-topic', 'a2a,mcp,ai-agents,agent-payments,escrow,agent-to-agent,model-context-protocol'], { cwd: out });
if (has('npm', ['whoami'])) sh('npm', ['publish', '--access', 'public'], { cwd: out });
else console.log('\nnpm: not logged in, so the npm package was not published. Run `npm login`, then `npm publish --access public` in ' + out);
if (has('mcp-publisher', ['--help'])) { sh('mcp-publisher', ['login', 'github'], { cwd: join(out, 'registry') }); sh('mcp-publisher', ['publish'], { cwd: join(out, 'registry') }); }
else console.log('\nMCP Registry: mcp-publisher is not installed, so the listing was not submitted. The entry is ready in ' + reg);
console.log(`\nDone.\nSandbox: ${url}\nCode: https://github.com/equinoxaifinance-rgb/pactwire`);
