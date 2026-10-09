// Prints a fresh Ed25519 private key (JWK) for an agent or for the Pactwire service. Keep it secret.
import { generateKeyPair } from '../src/crypto.mjs';
console.log(JSON.stringify((await generateKeyPair()).privateJwk));
