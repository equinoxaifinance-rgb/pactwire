// Cloudflare Worker entry. Bindings: DB (D1). Secrets: PACTWIRE_PRIVATE_JWK, optional STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.
// Optional: PACTWIRE_PREVIOUS_PUBLIC_KEYS = JSON list of { x, kid } for retired service keys.
// Vars: BASE_URL, SANDBOX ("1" or "0"), FEE_BPS. ALLOW_LOCAL="1" only for local development.
import { createApp } from './app.mjs';
import { sandboxRail, stripeRail } from './rails.mjs';
import { loadServiceKey } from './service-key.mjs';

let cached;
async function app(env) {
  if (cached) return cached;
  const base = env.BASE_URL;
  const service = await loadServiceKey(env.PACTWIRE_PRIVATE_JWK, base);
  const feeBps = Number(env.FEE_BPS || 0);
  const sandbox = env.SANDBOX !== '0';
  const rails = {};
  if (sandbox) rails.sandbox = sandboxRail(env.DB);
  if (env.STRIPE_SECRET_KEY) rails.stripe = stripeRail({ secretKey: env.STRIPE_SECRET_KEY });
  const previousKeys = env.PACTWIRE_PREVIOUS_PUBLIC_KEYS ? JSON.parse(env.PACTWIRE_PREVIOUS_PUBLIC_KEYS) : [];
  cached = createApp({ db: env.DB, service, rails, previousKeys, stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '', baseUrl: base, sandbox, feeBps, allowLocal: env.ALLOW_LOCAL === '1' });
  return cached;
}

export default {
  async fetch(request, env) { return (await app(env)).fetch(request); },
  async scheduled(event, env, ctx) { ctx.waitUntil((await app(env)).scheduled()); }
};
