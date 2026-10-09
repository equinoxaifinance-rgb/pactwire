// Signing and hashing for Pactwire. WebCrypto only, so the same code runs in
// Cloudflare Workers, Node 20+ and browsers.
//
// Every signed object is { payload, signer, sig }:
//   payload: plain JSON
//   signer:  the signer's id (an agent's origin, or the Pactwire service id)
//   sig:     base64url Ed25519 signature over canonical(payload)
// canonical() is RFC 8785-style JSON (sorted keys, no whitespace), so any
// language can re-create the exact bytes and check a signature offline.

const enc = new TextEncoder();

export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number cannot be signed');
    if (value === undefined) throw new Error('undefined cannot be signed');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(v => canonical(v === undefined ? null : v)).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function b64url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(text) {
  const s = atob(String(text).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(text).length + 3) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const hashJson = value => sha256Hex(canonical(value));

export async function generateKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
  // Keep only the key material: runtimes disagree on "alg" ("Ed25519" in Node, "EdDSA" in Workers).
  return { privateJwk: { kty: 'OKP', crv: 'Ed25519', x: priv.x, d: priv.d }, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: priv.x } };
}

export async function keyId(publicJwk) {
  // RFC 7638 JWK thumbprint for an OKP key.
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(canonical({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x })))));
}

const privCache = new WeakMap();
async function importPrivate(jwk) {
  if (privCache.has(jwk)) return privCache.get(jwk);
  if (jwk?.kty !== 'OKP' || jwk?.crv !== 'Ed25519' || !jwk.d || !jwk.x) throw new Error('private key must be an Ed25519 JWK');
  const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }, { name: 'Ed25519' }, false, ['sign']);
  privCache.set(jwk, key); return key;
}
async function importPublic(jwk) {
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('public key must be an Ed25519 JWK');
  return crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);
}

export async function sign(payload, signer, privateJwk) {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, await importPrivate(privateJwk), enc.encode(canonical(payload)));
  return { payload, signer, sig: b64url(new Uint8Array(sig)) };
}

export async function verify(signed, publicJwk) {
  if (!signed || typeof signed !== 'object' || typeof signed.sig !== 'string' || signed.payload === undefined) return false;
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, await importPublic(publicJwk), fromB64url(signed.sig), enc.encode(canonical(signed.payload)));
  } catch { return false; }
}

export function randomId(prefix) {
  return `${prefix}_${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
}
