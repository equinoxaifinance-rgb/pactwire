// Run Pactwire locally under Node: node server.mjs [port]
// Keeps its database and service key in .data/ (git-ignored).
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createApp } from './src/app.mjs';
import { openD1 } from './src/d1-sqlite.mjs';
import { sandboxRail, stripeRail } from './src/rails.mjs';
import { serveFetch } from './src/serve.mjs';
import { generateKeyPair } from './src/crypto.mjs';
import { loadServiceKey } from './src/service-key.mjs';
import { lookup } from 'node:dns/promises';
import { isPrivateAddress } from './src/a2a-client.mjs';

const port = Number(process.argv[2] || process.env.PORT || 8787);
const base = process.env.BASE_URL || `http://127.0.0.1:${port}`;
mkdirSync('.data', { recursive: true });
const keyFile = '.data/service-key.json';
if (!existsSync(keyFile)) writeFileSync(keyFile, JSON.stringify((await generateKeyPair()).privateJwk), { mode: 0o600 });
const service = await loadServiceKey(readFileSync(keyFile, 'utf8'), base);
const db = openD1('.data/pactwire.sqlite');
const rails = { sandbox: sandboxRail(db) };
if (process.env.STRIPE_SECRET_KEY) rails.stripe = stripeRail({ secretKey: process.env.STRIPE_SECRET_KEY, apiBase: process.env.STRIPE_API_BASE || 'https://api.stripe.com' });
const allowLocal = /127\.0\.0\.1|localhost/.test(base);
// Under Node there is no platform-level block on private addresses, so resolve every hostname first.
const resolveHost = async host => { const addrs = await lookup(host, { all: true }); if (!allowLocal && addrs.some(a => isPrivateAddress(a.address))) throw new Error('host resolves to a private address'); };
const app = createApp({ db, service, rails, baseUrl: base, sandbox: true, allowLocal, resolveHost, trustProxy: process.env.TRUST_PROXY === '1' });
const srv = await serveFetch(r => app.fetch(r), { port });
setInterval(() => app.scheduled().catch(e => console.error('sweep', e)), 60000).unref();
console.log(`Pactwire on ${srv.url}`);
