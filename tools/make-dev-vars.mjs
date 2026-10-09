// Writes .dev.vars (git-ignored) with a fresh service key, for `wrangler dev` on this machine only.
// Usage: node tools/make-dev-vars.mjs [port]
import { writeFileSync } from 'node:fs';
import { generateKeyPair } from '../src/crypto.mjs';

const port = Number(process.argv[2] || 8799);
const { privateJwk } = await generateKeyPair();
writeFileSync(new URL('../.dev.vars', import.meta.url), `PACTWIRE_PRIVATE_JWK='${JSON.stringify(privateJwk)}'\nALLOW_LOCAL=1\nBASE_URL=http://127.0.0.1:${port}\n`, { mode: 0o600 });
console.log(`wrote .dev.vars for port ${port}`);
