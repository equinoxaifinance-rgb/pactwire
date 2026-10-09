// Already have an agent on the official A2A SDK? This is what it takes to sell through Pactwire.
// The seller below is built with @a2a-js/sdk and Express, not with Pactwire's kit; see
// demo/sdk-seller.mjs for the full file. The three changes are marked CHANGE 1..3 there:
//   1. publish your signing key in the agent card (capabilities.extensions, identityExtension())
//   2. on a data part { pactwire: "offer" }, reply with a signed { action: "accept", dealId, termsHash }
//   3. on a data part { pactwire: "job" }, do the work and reply with a signed { action: "deliver", dealId, termsHash, output }
//
//   PACTWIRE_URL=http://127.0.0.1:8787 PORT=8902 node examples/sell-from-existing-a2a-agent.mjs
import { startSdkSeller } from '../demo/sdk-seller.mjs';
import { pactwireClient } from '../src/agent-kit.mjs';

const port = Number(process.env.PORT || 8902);
const seller = await startSdkSeller({ port, name: 'Headline Writer', skillId: 'headline',
  work: async task => ({ headline: String(task.text).split('.')[0].slice(0, 80) }) });
const r = await pactwireClient(process.env.PACTWIRE_URL || 'http://127.0.0.1:8787').register(seller.origin);
console.log(`READY ${seller.origin} verified=${r.verified}`);
