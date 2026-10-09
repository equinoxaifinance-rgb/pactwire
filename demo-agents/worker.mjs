// Public practice agents, so anyone can run a full sandbox deal through Pactwire in minutes.
// One script, deployed once per role (see wrangler.demo-agents.jsonc):
//   writer   - "Fact Sheet Writer": honest seller of fact_sheet jobs
//   cutter   - "Corner Cutter": seller that delivers sloppy work (to see a refund happen)
//   checker  - "Independent Checker": verifier agent that checks every fact appears in the source
// Secrets: AGENT_PRIVATE_JWK. Vars: ROLE, ORIGIN.
import { sellerAgent } from '../src/agent-kit.mjs';
import { keyId } from '../src/crypto.mjs';

const ROLES = {
  writer: {
    card: { name: 'Fact Sheet Writer', description: 'Practice seller for Pactwire. Turns { topic, sourceText } into { title, facts[] } using only sentences from the source.', version: '1.0.0' },
    skills: [{ id: 'fact_sheet', name: 'Fact sheet', description: 'Input { topic, sourceText }. Output { title, facts: string[] } where every fact is a sentence from sourceText.', tags: ['writing', 'practice', 'pactwire'], examples: ['{"topic":"Escrow","sourceText":"One. Two. Three."}'] }],
    work: async task => ({ title: `Fact sheet: ${String(task?.topic || 'untitled').slice(0, 80).toLowerCase()}`, facts: String(task?.sourceText || '').split(/(?<=\.)\s+/).map(s => s.trim()).filter(Boolean).slice(0, 10) })
  },
  cutter: {
    card: { name: 'Corner Cutter', description: 'Practice seller for Pactwire that cuts corners on purpose, so you can watch a refund happen.', version: '1.0.0' },
    skills: [{ id: 'fact_sheet', name: 'Fact sheet (cheap)', description: 'Claims to write fact sheets. Delivers one vague line.', tags: ['writing', 'practice', 'pactwire'] }],
    work: async () => ({ title: 'Stuff', facts: ['It is good.'] })
  },
  checker: {
    card: { name: 'Independent Checker', description: 'Practice verifier for Pactwire. Passes a fact sheet only if every fact appears word for word in the source text of the job.', version: '1.0.0' },
    skills: [{ id: 'verify_facts', name: 'Verify fact sheets', description: 'Use as a verifier_agent check. Signs pass/fail bound to the output hash.', tags: ['verification', 'practice', 'pactwire'] }],
    verify: async (output, check) => {
      const source = String(check?.sourceText || '');
      const facts = Array.isArray(output?.facts) ? output.facts : [];
      const ok = facts.length > 0 && source.length > 0 && facts.every(f => typeof f === 'string' && source.includes(f));
      return { verdict: ok ? 'pass' : 'fail', reason: ok ? 'every fact appears in the source' : 'a fact is missing from the source, or no source was given in the check' };
    }
  }
};

let handler;
async function build(env) {
  const role = ROLES[env.ROLE];
  if (!role) throw new Error(`ROLE must be one of ${Object.keys(ROLES).join(', ')}`);
  const priv = JSON.parse(env.AGENT_PRIVATE_JWK);
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: priv.x };
  const identity = { origin: env.ORIGIN.replace(/\/$/, ''), privateJwk: priv, publicJwk, kid: await keyId(publicJwk) };
  return sellerAgent({ identity, card: role.card, skills: role.skills, work: role.work, verify: role.verify });
}

export default {
  async fetch(request, env) {
    handler ||= await build(env);
    if (new URL(request.url).pathname === '/') return Response.redirect(new URL('/.well-known/agent-card.json', request.url).toString(), 302);
    return handler.fetch(request);
  }
};
