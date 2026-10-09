# Why Pactwire exists: the evidence

Sources were checked on 2026-10-07 and 2026-10-08. Quotes are copied from each source. Where a date was not visible, that is noted.

## 1. No agent payment waits for the work

- x402 issue #2222 (escrow proposal): "A single-round-trip settle has no recourse if the seller delivers nothing." No maintainer reply was visible. https://github.com/x402-foundation/x402/issues/2222 (date not visible)
- x402 issue #3500: "x402's payment flow is forward-only." https://github.com/x402-foundation/x402/issues/3500 (date not visible)
- x402 issue #3694 (job escrow via ERC-8183): "the concept of evaluating a job remains outside the semantics of auth-capture." Opened 2026-10-05; open; no maintainer reply was visible. https://github.com/x402-foundation/x402/issues/3694

## 2. The big payment protocols assume a human shopper and a merchant

- Google AP2: the cart mandate is signed "by the merchant entity (not an Agent)". Buyer-seller agent negotiation is listed as long-term work. https://ap2-protocol.org/specification/ (v0.1)

## 3. Nothing proves what was delivered for a payment

- In a study of ERC-8004 agent feedback, 98.7–100% has "neither payment proof nor task linkage." https://www.alphaxiv.org/abs/2606.26028 (2026-07-08)

## 4. Many listed agents don't work

- Only 21 of 50 "healthy" A2A agents completed a real `message/send`. https://github.com/a2aproject/A2A/issues/1934 (measurements taken 2026-06-12)
- "55 of 65 (about 85%)" of the agent cards found were not fully conformant. This line comes from a fetched summary of the post, so the original wording may differ. https://apievangelist.com/2026/07/29/most-published-agent-cards-are-not-actually-a2a/

## Others working on this (said plainly)

| Project | What it does | Source |
|---|---|---|
| Virtuals ACP | Escrowed agent jobs on-chain, with AI evaluators; reports large job volume | https://forkast.news/the-machine-as-buyer-virtuals-acp-and-the-evaluator-problem/ |
| agora402 | Releases USDC on Base when a schema check passes | https://socket.dev/npm/package/agora402 |
| PayCrow | USDC escrow for agents, exposed through MCP | https://www.getdrio.com/mcp/io-github-michu5696-paycrow/md |
| VCAP / SwarmSync | IETF draft for verified agent commerce, with Stripe Connect and a verifier | https://datatracker.ietf.org/doc/html/draft-stone-vcap |
| Underwrite | Agent-to-agent escrow protocol with simulated funds | https://dev.to/workflowbuilderai/im-an-ai-agent-and-i-built-an-escrow-protocol-for-agent-to-agent-work-1dhm |
| Timbro | Escrow for agents paying strangers; pre-launch | https://timbro.tech |

Pactwire's combination is what's new:
- checks both agents sign up front, with no AI judge
- a real card hold through Stripe Connect, not only crypto
- a public log signed with Ed25519 public keys that anyone can audit
- track records counted only from paid, settled deals
- plain A2A and MCP on both sides

Any one of these exists somewhere else.
