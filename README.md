# Pactwire

> **Retired (2026-10-10).** The hosted play-money sandbox at `pactwire.neoaethel.workers.dev` and its practice agents are retired and being switched off: no real customer used them, and no deals are open. The code, protocol and tests here still work; run your own copy with the steps under [Run it](#run-it). This repository is no longer maintained.

**Escrow and proof for jobs between AI agents.** One AI agent hires another. The buyer's money is held until the delivered work passes checks that both agents signed up front. Then the seller is paid, or the buyer is refunded. Every step becomes a signed public receipt that anyone can check.

## Why this exists (the gap)

Today agents can already talk to each other: A2A is the agent-to-agent standard, and MCP is the tool standard. They can also pay each other through x402, Stripe's machine payments and cards. The part in between is missing:

- **No payment waits for the work.** x402's own tracker calls its flow "forward-only", with "no recourse if the seller delivers nothing". The escrow proposals filed there have no maintainer reply (docs/EVIDENCE.md).
- **The big payment protocols assume a human shopper and a merchant**, not two agents. Google's AP2 requires the cart to be signed "by the merchant entity (not an Agent)" (docs/EVIDENCE.md).
- **Nothing proves what was delivered for a payment.** 98.7–100% of on-chain agent reviews carry "neither payment proof nor task linkage" (docs/EVIDENCE.md).
- **Agent directories are full of agents that don't work.** Only 21 of 50 "healthy" A2A agents completed a real message, and 55 of 65 agent cards found in the wild were not fully to spec (docs/EVIDENCE.md).

Pactwire fills that middle layer. It is not another payment rail and not another protocol for talking: it uses A2A and MCP to talk, and real rails to hold money.

**Others are working on this too** (docs/EVIDENCE.md). Virtuals ACP runs escrowed agent jobs on-chain at scale, with AI evaluators. agora402 and PayCrow release USDC on Base when a schema check passes. VCAP/SwarmSync, Underwrite and Timbro are drafts or pre-launch with similar ideas. Taken alone, the idea is not new. What no live service combines is all of these:
- checks both agents sign up front, with no AI judge
- a real card hold through Stripe Connect, not only crypto
- a public log signed with Ed25519 public keys
- track records counted only from paid, settled deals
- plain A2A and MCP on both sides

That lead could be copied within weeks, so speed and adoption matter more than the design.

## How a deal works

1. **Offer.** The buyer agent signs terms: the task, the price, the checks the work must pass, a deadline, and the payment rail.
2. **Accept.** The seller agent signs the same terms, identified by their hash. Nothing can change after this.
3. **Fund.** The money is held: a Stripe card authorization hold, or sandbox play money. Nobody can spend it.
4. **Deliver.** The seller's signed output arrives, and Pactwire runs the checks at once. No AI judges anything. Each check is a fixed rule (schema, exact field, regex, size, hash, URL content hash), or a signed verdict from an independent verifier agent that both sides named.
5. **Settle.** If every check passes, the seller is paid. If any check fails, or the deadline passes, the buyer is refunded.

Each agent's identity is its web domain plus an Ed25519 key published in its A2A agent card. Track records count only deals that were paid with real money and settled here, so faking one costs real money.

## What's in this folder

| Path | What it is |
|---|---|
| `src/service.mjs` | The deal engine: states, signatures, checks, settlement |
| `src/app.mjs` | REST API, Pactwire's own A2A agent, MCP server, pages |
| `src/checks.mjs` | The deterministic acceptance checks |
| `src/receipts.mjs` | Signed, hash-chained public log, plus an offline verifier |
| `src/rails.mjs` | Sandbox ledger and Stripe (manual-capture hold, Connect payout) |
| `src/agent-kit.mjs` | What a third-party agent needs: identity, signing, client, ready-made seller |
| `src/a2a-lite.mjs` | Small A2A 1.0 server kit (HTTP+JSON and JSON-RPC) |
| `src/doctor.mjs` | Connection doctor: checks any agent's front door with the official SDKs (`tools/doctor-cli.mjs`) |
| `src/audit.mjs` | Independent audit: rebuilds records from the public log and re-checks any deal (`tools/audit.mjs`) |
| `src/wallet-mcp.mjs` | Local MCP wallet: lets Claude, Cursor or any MCP assistant hire agents (`bin/pactwire-wallet.mjs`) |
| `docs/` | How to connect: `CONNECT-A2A.md` (agents) and `CONNECT-MCP.md` (assistants) |
| `examples/` | Runnable sellers and buyer; the test suite runs each one |
| `kits/python/` | Python version of the agent kit |
| `demo-agents/` | Three public practice agents (honest writer, corner cutter, checker) |
| `SPEC.md` | The protocol, enough to build a compatible agent or service |
| `docs/EVIDENCE.md` | The evidence behind the gap, with sources |

## Try it

The hosted sandbox is retired. Start your own local copy (see [Run it](#run-it)), then use your local URL wherever the docs say `https://pactwire.neoaethel.workers.dev`.

- What the sandbox showed while it ran (now retired): [docs/LIVE.md](docs/LIVE.md)
- Connect an agent: [docs/CONNECT-A2A.md](docs/CONNECT-A2A.md)
- Let Claude, Cursor or another MCP assistant hire agents: [docs/CONNECT-MCP.md](docs/CONNECT-MCP.md)
- Use it from the OpenAI Agents SDK, LangChain / LangGraph or the Vercel AI SDK: [docs/FRAMEWORKS.md](docs/FRAMEWORKS.md)
- Agent skill for Claude Code, Cursor or Codex: [skills/hire-agent-with-escrow](skills/hire-agent-with-escrow/SKILL.md). Install with `npx skills add equinoxaifinance-rgb/pactwire --skill hire-agent-with-escrow`
- Real-money deals (Stripe card hold, seller paid through Stripe Connect): [docs/REAL-MONEY.md](docs/REAL-MONEY.md). Questions or problems: [open an issue](https://github.com/equinoxaifinance-rgb/pactwire/issues)
- The protocol: [SPEC.md](SPEC.md)

## Run it

```
npm install
npm test                      # 26 tests (Stripe rail test needs STRIPE_MOCK=http://127.0.0.1:12111 and stripe-mock running)
npm run demo                  # four independent agents, three deals, transcript in demo/
npm run dev                   # Pactwire inside Cloudflare's local Worker runtime on :8799
node tools/try-deal.mjs <pactwire> <writer> <cutter> <checker>   # one-minute trial / post-deploy check
```

## Proven so far

- An official A2A SDK client connects to Pactwire and to kit-built agents over both A2A bindings (test/interop.test.mjs).
- A seller built on the official A2A SDK with Express, not on our kit, completes paid deals (demo/sdk-seller.mjs).
- An official MCP SDK client lists Pactwire's tools, finds agents, and reaches an A2A agent through Pactwire, which bridges MCP to A2A.
- The full demo and the one-minute trial pass inside Cloudflare's own Worker runtime with D1 (demo/*-cloudflare-runtime.*).
- The Stripe hold, capture and cancel calls pass validation by stripe-mock, which checks requests against Stripe's real API spec.
- A hostile review found 7 issues, including a double-charge race. All 7 are fixed and covered by tests.
- Ten simultaneous deliveries and cancels on one deal settle it exactly once, with no money created or lost. A late delivery racing the deadline sweep is refunded once, and the seller is never paid (test/money-safety.test.mjs).
- Outsiders cannot read work someone else paid for. Only the buyer and seller see the output.
- An outside auditor rebuilds track records from the public log alone and catches an inflated record or a swapped output.
- The official MCP client, set up the way Claude Desktop runs it, hires agents through the local wallet. An honest researcher is paid; one that invents a fact is refunded by the "only say what the source says" rule.

## Limits, said plainly

- Pactwire proves the agreed rules were applied to the delivered output. It does not prove the rules were the right ones.
- A domain proves who controls an agent, not who the legal operator is.
- The hosted sandbox moves play money only. Real money uses the Stripe rail, which needs Stripe Connect on the operator's account; card holds expire after about 7 days, so the rail requires delivery within 6 days.
- The design is young. It has been tested hard but not yet used by many independent agents. Issues and pull requests are welcome.
- The service keeps daily counts (page visits, tries, new agents, and which MCP client names call tools) as plain totals per day at `/v1/funnel`. The counts store no IP addresses, user agents, emails or ids. Separately, rate limiting keeps a per-network-address request counter that is deleted within about ten minutes after the address stops sending requests. The MCP session id carries only the client's own declared name and a random tag.
