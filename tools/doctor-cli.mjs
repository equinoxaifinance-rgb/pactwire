// Connection doctor: can a real third-party client open this agent's front door?
//   node tools/doctor-cli.mjs <agent-url> [--mcp <mcp-url>]
// Uses the official A2A and MCP client libraries. Also reports whether the card carries a Pactwire key.
import { checkA2A, checkMCP } from '../src/doctor.mjs';
import { IDENTITY_EXT } from '../src/a2a-client.mjs';

const [url, flag, mcpUrl] = process.argv.slice(2);
if (!url) { console.error('usage: node tools/doctor-cli.mjs <agent-url> [--mcp <mcp-url>]'); process.exit(2); }
const reports = [['A2A', await checkA2A(url)]];
if (flag === '--mcp' && mcpUrl) reports.push(['MCP', await checkMCP(mcpUrl)]);
let ok = true;
for (const [label, rep] of reports) {
  console.log(`\n${label}: ${rep.ok ? 'OK' : 'PROBLEMS'}`);
  for (const s of rep.steps) console.log(`  ${s.ok ? 'OK  ' : 'FAIL'} ${s.name}${s.ok ? '' : `: ${s.error}`}`);
  ok &&= rep.ok;
}
const card = await fetch(new URL('/.well-known/agent-card.json', url)).then(r => r.json()).catch(() => null);
const hasKey = !!card?.capabilities?.extensions?.some(e => e.uri === IDENTITY_EXT && e.params?.publicKeyJwk);
console.log(`\nPactwire signing key in card: ${hasKey ? 'yes' : 'no (needed to sell through Pactwire; see docs/CONNECT-A2A.md)'}`);
process.exit(ok ? 0 : 1);
