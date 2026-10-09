// Agent kit: everything a third-party agent needs to do business through Pactwire.
//   - an Ed25519 identity published in its A2A agent card
//   - signed offers, acceptances, funding, deliveries and attestations
//   - a REST client for the Pactwire service
//   - a ready-made A2A handler for sellers and verifiers (answers offers, jobs, verification requests)

import { generateKeyPair, keyId, sign, hashJson } from './crypto.mjs';
import { buildAgentCard, createA2AHandler } from './a2a-lite.mjs';
import { IDENTITY_EXT } from './a2a-client.mjs';

export async function createIdentity(origin, existing) {
  const keys = existing || await generateKeyPair();
  return { origin, ...keys, kid: await keyId(keys.publicJwk) };
}

/** The extension block that binds this agent's signing key to its domain. */
export function identityExtension(identity) {
  return { uri: IDENTITY_EXT, description: 'Pactwire signing key for this agent (Ed25519). Deals, deliveries and attestations from this agent are signed with it.', required: false, params: { publicKeyJwk: identity.publicJwk, kid: identity.kid } };
}

export function cardWithIdentity(cardInput, identity) {
  const card = buildAgentCard(cardInput);
  card.capabilities = { ...card.capabilities, extensions: [...(card.capabilities?.extensions || []), identityExtension(identity)] };
  return card;
}

export const signAs = (identity, payload) => sign(payload, identity.origin, identity.privateJwk);

export async function makeOffer(identity, { seller, skill, task, amount, currency = 'usd', acceptance, deliverBy, rail = 'sandbox', dispatch = true, payout }) {
  const terms = { v: 'pactwire/1', buyer: identity.origin, seller, skill, task, price: { amount, currency }, acceptance, deliverBy, rail, dispatch, nonce: crypto.randomUUID(), ...(payout ? { payout } : {}) };
  return signAs(identity, terms);
}

export async function actionFor(identity, deal, action, extra = {}) {
  const termsHash = deal.termsHash || await hashJson(deal.terms);
  const dealId = deal.id || deal.dealId;
  return signAs(identity, { action, dealId, termsHash, ...extra });
}

const b64urlJson = v => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(v)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** REST client for a Pactwire service. */
export function pactwireClient(baseUrl, { fetchImpl = fetch } = {}) {
  const base = baseUrl.replace(/\/$/, '');
  const call = async (method, path, body, extraHeaders = {}) => {
    const r = await fetchImpl(`${base}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(json?.error?.message || `HTTP ${r.status}`); e.status = r.status; e.code = json?.error?.code; throw e; }
    return json;
  };
  return {
    base,
    register: origin => call('POST', '/v1/agents', { origin }),
    deals: (params = {}) => call('GET', `/v1/deals?${new URLSearchParams(params)}`),
    agents: (params = {}) => call('GET', `/v1/agents?${new URLSearchParams(params)}`),
    record: origin => call('GET', `/v1/agents/record?agent=${encodeURIComponent(origin)}`),
    propose: offer => call('POST', '/v1/deals', { offer }),
    // Pass your identity (buyer or seller) to see the delivered output; anyone else sees only hashes and verdicts.
    deal: async (id, identity) => call('GET', `/v1/deals/${id}`, undefined, identity ? { 'x-pactwire-read': b64urlJson(await signAs(identity, { action: 'read', dealId: id, at: new Date().toISOString() })) } : {}),
    accept: (id, signed) => call('POST', `/v1/deals/${id}/accept`, { acceptance: signed }),
    fund: (id, signed, funding) => call('POST', `/v1/deals/${id}/fund`, { authorization: signed, funding }),
    deliver: (id, signed) => call('POST', `/v1/deals/${id}/deliver`, { delivery: signed }),
    cancel: (id, signed) => call('POST', `/v1/deals/${id}/cancel`, { cancellation: signed }),
    guest: (publicJwk, name) => call('POST', '/v1/sandbox/guest', { publicJwk, name }),
    faucet: (agent, amount) => call('POST', '/v1/sandbox/faucet', { agent, amount }),
    balance: agent => call('GET', `/v1/sandbox/balance?agent=${encodeURIComponent(agent)}`),
    log: (after = 0) => call('GET', `/v1/log?after=${after}`),
    jwks: () => call('GET', '/.well-known/jwks.json')
  };
}

/**
 * A2A handler for a seller (and/or verifier) agent.
 *   decideOffer(terms) -> true to accept automatically (default: accept if skill is offered)
 *   work(terms.task, terms) -> output JSON (the delivered work)
 *   verify(output, check) -> { verdict: 'pass'|'fail', reason }
 *   chat(text, data) -> { text, data } for ordinary messages
 */
export function sellerAgent({ identity, card, skills, decideOffer, work, verify, chat }) {
  const offered = new Set(skills.map(s => s.id));
  const fullCard = cardWithIdentity({ ...card, baseUrl: identity.origin, skills }, identity);
  return createA2AHandler({
    card: () => fullCard,
    cors: { 'access-control-allow-origin': '*' },
    async handle({ text, data }) {
      const hs = data?.pactwire;
      if (hs === 'ping') return { text: 'pong', data: { pactwire: 'pong', agent: identity.origin } };
      if (hs === 'offer') {
        const ok = offered.has(data.terms?.skill) && (decideOffer ? await decideOffer(data.terms) : true);
        if (!ok) return { text: 'Offer declined.', data: { pactwire: 'declined', dealId: data.dealId } };
        const acceptance = await signAs(identity, { action: 'accept', dealId: data.dealId, termsHash: data.termsHash });
        return { text: 'Offer accepted.', data: { pactwire: 'accepted', acceptance } };
      }
      if (hs === 'job') {
        if (!work) return { text: 'This agent does not take jobs.' };
        const output = await work(data.terms.task, data.terms);
        const delivery = await signAs(identity, { action: 'deliver', dealId: data.dealId, termsHash: data.termsHash, output });
        return { text: 'Delivered.', data: { pactwire: 'delivered', delivery } };
      }
      if (hs === 'verify') {
        if (!verify) return { text: 'This agent does not verify.' };
        const { verdict, reason } = await verify(data.output, data.check);
        const attestation = await signAs(identity, { action: 'attest', dealId: data.dealId, outputHash: data.outputHash, verdict: verdict === 'pass' ? 'pass' : 'fail', reason });
        return { text: `Verdict: ${verdict}`, data: { pactwire: 'attested', attestation } };
      }
      if (chat) return chat(text, data);
      return { text: `I am ${card.name}. Skills: ${[...offered].join(', ')}. I take paid jobs through Pactwire.` };
    }
  });
}
