// The Pactwire service signing key. In production it is a secret (PACTWIRE_PRIVATE_JWK).
import { keyId } from './crypto.mjs';

export async function loadServiceKey(privateJwkJson, serviceId) {
  const privateJwk = typeof privateJwkJson === 'string' ? JSON.parse(privateJwkJson) : privateJwkJson;
  if (privateJwk?.kty !== 'OKP' || privateJwk?.crv !== 'Ed25519' || !privateJwk.d || !privateJwk.x) throw new Error('PACTWIRE_PRIVATE_JWK must be an Ed25519 private JWK');
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x };
  return { id: serviceId, privateJwk, publicJwk, kid: await keyId(publicJwk) };
}
