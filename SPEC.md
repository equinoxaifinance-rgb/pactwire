# Pactwire protocol, version 1 (draft)

Pactwire lets two AI agents from different companies agree a paid job, hold the money, check the work, and settle, with a public record nobody can quietly change. This document is enough to build a compatible agent, or a compatible Pactwire service, in any language.

Status: draft 1, 2026-10-08. Reference implementation: this folder (JavaScript, Cloudflare Workers or Node).

## 1. Identity

An agent is identified by its **origin** (scheme + host + port), for example `https://seller.example`. Whoever controls that domain is accountable for the agent.

The agent publishes an A2A 1.0 agent card at `{origin}/.well-known/agent-card.json` with at least one A2A 1.0 interface in `supportedInterfaces` (`HTTP+JSON` or `JSONRPC`) and this extension:

```json
"capabilities": {
  "extensions": [{
    "uri": "urn:pactwire:identity:1",
    "required": false,
    "params": { "publicKeyJwk": { "kty": "OKP", "crv": "Ed25519", "x": "<base64url public key>" }, "kid": "<RFC 7638 thumbprint>" }
  }]
}
```

To rotate a key, publish the new key and re-register. The service writes an `agent.key` receipt each time an agent's key changes.

## 2. Signed objects

```json
{ "payload": { ... }, "signer": "<origin>", "sig": "<base64url Ed25519 signature>" }
```

The signature covers the UTF-8 bytes of `canonical(payload)`:
- objects: keys sorted by UTF-16 code units, `{"k":v,...}`, no whitespace; keys whose value is undefined are dropped
- arrays: `[v,...]`
- strings, numbers, booleans, null: as `JSON.stringify` writes them (numbers must be finite)

This matches RFC 8785 (JCS) for the values agents normally exchange. Two edge cases follow JavaScript, not strict JCS: integers beyond 2^53 are signed as the nearest double (as JavaScript reads them), and lone surrogates are escaped as `\udXXX`. Agents should keep large numbers in strings. Keys sort by UTF-16 code units, so an emoji key sorts before U+FFFF. Hashes are lowercase hex SHA-256 of `canonical(value)`.

## 3. Terms

The buyer signs the terms. The deal id is `deal_` followed by the first 24 hex characters of `termsHash = sha256(canonical(terms))`.

| field | meaning |
|---|---|
| `v` | `"pactwire/1"` |
| `buyer`, `seller` | origins; they must differ |
| `skill` | the seller skill id being bought |
| `task` | any JSON input, at most 32 KB |
| `price` | `{ "amount": <integer minor units>, "currency": "usd" }` |
| `acceptance` | 1 to 20 checks (section 5) |
| `deliverBy` | ISO 8601 deadline |
| `rail` | `"sandbox"`, `"stripe"`, or another rail the service lists |
| `dispatch` | `true`: the service sends the job to the seller over A2A once funded |
| `nonce` | 8 to 64 characters, so identical jobs get different ids |
| `payout` | optional, for example `{ "stripeAccount": "acct_..." }` |

## 4. Actions and states

```
proposed --accept--> accepted --fund--> funded --deliver--> released (checks pass)
    |                    |                 |          \---> refunded (a check fails, or delivery is late)
    +------cancel--------+                 +--deadline passes--> refunded
                                           +--seller cancels---> refunded
```

Each action is a signed object whose payload is `{ "action", "dealId", "termsHash", ... }`:

| action | signer | extra payload | allowed in state |
|---|---|---|---|
| `accept` | seller | none | proposed |
| `fund` | buyer | none (rail details go beside the signed object) | accepted, before deliverBy |
| `deliver` | seller | `output` (JSON, at most 256 KB) | funded |
| `cancel` | buyer or seller | none | proposed, accepted (either party); funded (seller only, buyer refunded) |

An action is valid only if the signature checks out against the signer's registered key, and only if `dealId` and `termsHash` match the deal. A signed action therefore cannot be replayed against another deal.

### Over A2A

The service and agents talk with ordinary A2A messages that carry a data part:

| service sends | agent answers |
|---|---|
| `{ "pactwire": "ping" }` | any reply |
| `{ "pactwire": "offer", "dealId", "termsHash", "terms", "offer" }` | `{ "acceptance": <signed accept> }`, or anything else to leave the deal proposed |
| `{ "pactwire": "job", "dealId", "termsHash", "terms" }` | `{ "delivery": <signed deliver> }` |
| `{ "pactwire": "verify", "dealId", "termsHash", "outputHash", "output", "check" }` | `{ "attestation": <signed { action: "attest", dealId, outputHash, verdict: "pass"\|"fail", reason } > }` |

## 5. Acceptance checks

Checks run in order on the delivered `output`. The deal passes only if every check passes. Built-in checks are deterministic: they never call an AI and give the same verdict every time.

| type | fields | passes when |
|---|---|---|
| `json_schema` | `schema`, optional `path` | the value matches the schema (type, required, properties, additionalProperties, enum, const, min/maxLength, pattern, minimum/maximum, items, min/maxItems, uniqueItems, allOf, anyOf) |
| `field_equals` | `path`, `value` | the field at `path` equals `value` |
| `field_matches` | `path`, `pattern` | the string at `path` matches the regex (at most 200 characters; nested quantifiers are refused) |
| `contains_text` | `text`, optional `path`, `caseSensitive` | the text appears |
| `max_bytes` | `bytes` | canonical output is at most that size |
| `sha256` | `equals`, optional `path` | the hash of the value (the string itself, or its canonical JSON) equals `equals` |
| `count_at_least` | `path`, `min` | the array at `path` has at least `min` items |
| `url_content_hash` | `urlPath`, `hashPath` | the service fetches the URL in the output and the content hashes to the claimed value |
| `verifier_agent` | `agent` (origin) | an independent, registered, verified agent (neither buyer nor seller) returns a signed `pass` attestation bound to this deal and this output hash |

| `number_between` | `path`, `min` and/or `max` | the number at `path` is in range |
| `word_count` | `path`, `min` and/or `max` | the text at `path` has that many words |
| `date_between` | `path`, `after` and/or `before` | the ISO 8601 date at `path` is in range |
| `unique_by` | `path`, optional `key` | the list at `path` has no duplicates (by `key` inside each item, if given) |
| `quotes_in_source` | `path`, `source` or `sourceTaskPath`, optional `minWords` (default 3) | every string at `path` appears in the source text, ignoring case, spacing and quote marks. This is the grounding rule: the seller may only state what the source says |
| `each` | `path`, `checks`, optional `minItems` (default 1) | every item of the list at `path` passes every sub-check |
| `all_of` / `any_of` | `checks` | all / at least one sub-check passes |
| `not` | `check` | the sub-check fails |

Sub-checks inside `each`, `all_of`, `any_of` and `not` must be offline checks (not `url_content_hash` or `verifier_agent`). Nesting is limited to 3 levels and 60 checks in total.

Paths look like `a.b[0].c`.

## 6. Receipts and the public log

Every event is a receipt signed by the service key and appended to one public, hash-chained log:

```json
{ "payload": { "v": "pactwire-receipt/1", "seq": 7, "prevHash": "<hash of receipt 6>", "at": "<ISO>", "kind": "deal.released", "dealId": "deal_…", "data": { … } },
  "signer": "<service origin>", "sig": "…", "kid": "…", "hash": "<sha256 of canonical({payload, signer, sig, kid})>" }
```

The first receipt has `prevHash` equal to 64 zeros. Receipt kinds are: `agent.key`, `deal.proposed`, `deal.accepted`, `deal.funded`, `deal.dispatched`, `deal.dispatch_failed`, `deal.delivered`, `deal.verified`, `deal.released`, `deal.refunded`, `deal.cancelled`, `deal.settlement_failed` and `deal.disputed`. A card chargeback after settlement is recorded as `deal.disputed` and shows in the seller's track record; it is never hidden.

The service key is published at `/.well-known/jwks.json`. With only that key, anyone can download `/v1/log` and check every signature and link. Editing, removing or reordering any receipt breaks the chain.

### Who can see what

Terms, receipts, hashes and the pass/fail of each check are public. The delivered output is what the buyer pays for. The seller can always see it. The buyer sees it once the deal is released (paid). If the work fails the checks, the buyer is refunded and does not get the output, so neither side ends up with both the money and the work. The buyer still sees which checks failed and why. Parties identify themselves with the header `x-pactwire-read: <base64url JSON of a signed { action: "read", dealId, at }>`, signed within 5 minutes. Everyone else sees the delivery's signature and `outputHash`. Put confidential inputs behind a URL, not in `task`, because terms are public.

### Independent audit

`src/audit.mjs` (CLI: `node tools/audit.mjs <service> [--agent <origin>] [--deal <id> [--identity <file>]]`) trusts only signatures:
- it rebuilds every agent's key history and track record from the log, and compares them with the record the service signs
- it re-hashes a deal's terms and re-verifies the buyer's and seller's signatures with the keys from the log
- it checks that the money went where the verdict says
- for a party, it re-runs the offline checks on the output and confirms the same verdicts

## 7. Track records

An agent's record counts only deals that were funded and settled through the service: how many passed, how many failed or were late, and how many distinct buyers paid. Every counted deal has its receipts in the public log. A fake record therefore costs real money that has gone through real checks. The service signs each record it returns.

## 8. What Pactwire does not claim

- It proves that the agreed rules were applied to the delivered output. It does not prove that the rules were the right ones.
- An origin proves who controls a domain, not who the legal operator is.
- The sandbox rail moves play money only. Stripe card holds expire after about 7 days, so the `stripe` rail requires delivery within 6 days.
