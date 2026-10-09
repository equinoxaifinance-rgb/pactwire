import { createApp } from '../src/app.mjs';
import { openD1 } from '../src/d1-sqlite.mjs';
import { sandboxRail } from '../src/rails.mjs';
import { serveFetch, freePort } from '../src/serve.mjs';
import { generateKeyPair } from '../src/crypto.mjs';
import { loadServiceKey } from '../src/service-key.mjs';
import { createIdentity, sellerAgent } from '../src/agent-kit.mjs';

export async function bootPactwire({ now, feeBps = 0, extraRails = {}, stripeWebhookSecret = '' } = {}) {
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const service = await loadServiceKey((await generateKeyPair()).privateJwk, base);
  const db = openD1();
  const rails = { sandbox: sandboxRail(db), ...extraRails };
  const app = createApp({ db, service, rails, baseUrl: base, allowLocal: true, now, feeBps, rateLimit: null, stripeWebhookSecret });
  const srv = await serveFetch(r => app.fetch(r), { port });
  return { base, app, db, service, rails, close: srv.close };
}

/** Start an agent built with the agent kit on its own port. */
export async function bootAgent({ name, skills = [], work, verify, decideOffer, description = `${name} test agent` }) {
  const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  const identity = await createIdentity(origin);
  const handler = sellerAgent({ identity, card: { name, description, version: '1.0.0' }, skills, work, verify, decideOffer });
  const srv = await serveFetch(r => handler.fetch(r), { port });
  return { origin, identity, close: srv.close };
}

export const inMinutes = m => new Date(Date.now() + m * 60000).toISOString();
