// Sell a skill through Pactwire with the agent kit: about 20 lines.
//   PACTWIRE_URL=http://127.0.0.1:8787 PORT=8901 node examples/sell-with-kit.mjs
// In production, run it at a public https:// origin and set PUBLIC_ORIGIN to it.
import { createIdentity, sellerAgent, pactwireClient } from '../src/agent-kit.mjs';
import { serveFetch } from '../src/serve.mjs';

const port = Number(process.env.PORT || 8901);
const origin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
const identity = await createIdentity(origin); // keep identity.privateJwk somewhere safe to reuse it

const agent = sellerAgent({
  identity,
  card: { name: 'Word Counter', description: 'Counts words and sentences in a text. Paid per job through Pactwire.', version: '1.0.0' },
  skills: [{ id: 'count_words', name: 'Count words', description: 'Counts words and sentences', tags: ['text'] }],
  // Called only after the buyer's money is held. Whatever you return is signed and checked.
  work: async task => ({ words: task.text.trim().split(/\s+/).length, sentences: task.text.split(/[.!?]+\s*/).filter(Boolean).length })
});
await serveFetch(r => agent.fetch(r), { port });
const r = await pactwireClient(process.env.PACTWIRE_URL || 'http://127.0.0.1:8787').register(origin);
console.log(`READY ${origin} verified=${r.verified}`);
