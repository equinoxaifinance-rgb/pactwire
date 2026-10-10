# Pactwire guard: know what your agent's paid calls really returned

x402 sellers take payment before or while they answer, and nothing checks the answer. A paid call can settle on-chain and still return a 500, an empty body, or JSON that isn't what the listing promised. Public trackers have examples:

- [alchemy-x402 #47](https://github.com/alchemyplatform/alchemy-x402/issues/47): "settled on-chain, but the response was an error, so the payment bought nothing."
- [BankrBot/x402-cli-example #5](https://github.com/BankrBot/x402-cli-example/issues/5): six paid attempts, each returning an empty 500.

The guard is a few lines placed under your x402 client. It checks every paid response, writes a signed verdict to a local ledger, and stops your agent from paying an endpoint or seller that keeps charging for nothing. It refuses before any payment is signed. It never touches your wallet or keys.

## Use it

```js
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { createGuard } from 'pactwire/guard';
import { fileLedger, fileKey } from 'pactwire/guard-file';

const guard = createGuard({
  ledger: await fileLedger('.pactwire/ledger.jsonl'),
  key: await fileKey('.pactwire/guard-key.json'),   // signs verdicts only; holds no money
});
const pay = wrapFetchWithPayment(guard.fetch, client);  // the guard goes UNDER the payer

const res = await pay('https://seller.example/search?q=...');
const verdict = guard.verdictFor(res);
if (!verdict.ok) console.log('paid for nothing:', verdict.problems);
```

When an endpoint or seller has failed too often, `pay(...)` throws a `GuardBlockedError` and nothing is paid. `guard.unblock(url)` or `guard.unblock({ payTo })` lets your agent try it again.

## What it checks on every paid answer

| Problem | Level | Meaning |
|---|---|---|
| `http_error` | fail | The status was not 2xx after paying. |
| `empty_body`, `empty_result` | fail | Nothing came back, or `{}`, `[]` or `null`. |
| `bad_json` | fail | The response says JSON but doesn't parse. |
| `off_schema` | fail | The response doesn't match the output schema the seller declared in its Bazaar listing. |
| `check_failed` | fail | One of your own Pactwire checks failed (`count_at_least`, `field_matches`, `quotes_in_source`, …). |
| `missing_example_fields`, `empty_list` | warn | The response is missing fields the seller's example has, or a list came back empty. |
| `error_in_body` | warn | The status was 200, but the body is an error message. |

Payment state comes from the seller's settlement header:
- `yes`: settled.
- `no`: no payment was taken.
- `likely`: a payment was sent but the seller returned no settlement header.

A verdict with `paidForNothing: true` is a failed answer you were (likely) charged for.

## When it refuses

These are the defaults. Change them with `createGuard({ policy })`.
- An endpoint is refused after 2 paid-for-nothing answers in its last 5 paid calls.
- A seller (its `payTo` address) is refused across all its endpoints after 3 paid-for-nothing answers in its last 10 paid calls.

## Other payment methods

For a paid call that isn't x402 (an MCP tool, a card-billed API), record it yourself:
`await guard.check({ resource, status, body, amount, payTo })`

## The command line

```
pactwire-guard check <url>    # free: price, payTo, declared schema, and whether the seller's example matches its own schema. Never pays.
pactwire-guard report         # per endpoint and per seller: paid calls, paid for nothing, money spent and wasted
pactwire-guard verify         # every verdict is signed and hash-chained; this proves the ledger was not edited
```

## What it is not

- It doesn't get your money back. x402 itself has no refund step (proposals such as [x402r](https://ethglobal.com/showcase/x402r-and-d-1k9yg) are working on one). The guard stops the next payment and gives you a signed, timestamped record (transaction id, status, body hash) to show the seller.
- It only judges what it can see: the status, the body, the seller's own declaration, and your checks. It doesn't judge whether a correct-looking answer is true. For that, use a check such as `quotes_in_source` or a verifier.
