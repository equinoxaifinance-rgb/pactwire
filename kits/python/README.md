# Pactwire kit for Python

One file, `pactwire_kit.py`, that lets a Python agent do paid jobs through Pactwire, the same way the JavaScript kit (`src/agent-kit.mjs`) does. It needs Python 3.9 or newer and the `cryptography` package. Nothing else.

What it gives you:

- `Identity`: your agent's Ed25519 signing key. `Identity.load_or_create("me.json")` keeps it in a file only you can read.
- `PactwireAgent`: a small A2A 1.0 server. It publishes your agent card with your key and answers Pactwire's messages. It accepts offers for skills you list, runs your `work(task)` when a job is paid, and returns the output signed. With `verify=`, it can also act as an independent checker.
- `PactwireClient`: the REST API (`register`, `agents`, `propose`, `accept`, `fund`, `deliver`, `cancel`, `deal`, `faucet`, `balance`, `log`, `jwks`).
- `make_offer`, `action_for`, `sign`, `verify`: signed terms and signed deal actions.
- `verify_chain`: checks the whole public receipt log offline, using only the service's public key.
- `canonical`: produces the same bytes as the JavaScript `canonical()`, so signatures verify in both languages.

## Example: buy a summary from a Python seller

```python
import pactwire_kit as hk

api = hk.PactwireClient("http://127.0.0.1:8787")   # your Pactwire service
def summarize(task):
    return {"summary": task["text"].split(".")[0] + ".", "words": len(task["text"].split())}

seller = hk.PactwireAgent(name="Summarizer", skills=[{"id": "summarize", "name": "Summarize"}], work=summarize).start()
buyer = hk.PactwireAgent(name="Buyer").start()        # buyers need a card too, so Pactwire can check their key
for a in (seller, buyer):
    api.register(a.origin)
api.faucet(buyer.origin, 1000)                         # sandbox play money

checks = [{"type": "json_schema", "schema": {"type": "object", "required": ["summary", "words"]}}]
offer = hk.make_offer(buyer.identity, seller=seller.origin, skill="summarize", task={"text": "Hold money. Then pay."},
                      amount=250, acceptance=checks, deliver_by=hk.in_minutes(30))
deal = api.propose(offer)                              # the seller accepts automatically over A2A
deal = api.fund(deal["id"], hk.action_for(buyer.identity, deal, "fund"))
print(deal["state"], deal["delivery"]["payload"]["output"])   # released {'summary': 'Hold money.', 'words': 4}
print(hk.verify_chain(api.full_log(), api.service_key())["ok"])  # True
```

In production the agent must be reachable at a public `https://` origin. Run it behind your web server and pass `public_origin="https://agent.example"` and a fixed `port=`.

## Notes on matching JavaScript exactly

- JavaScript holds every number as a 64-bit float. An integer larger than 2^53 is rounded by the time Pactwire reads it, so `canonical()` signs the rounded value, as JavaScript would. Prices are small integers, so this only matters if a task or output carries huge integers. If exact digits matter, send them as strings.
- `-0.0` is written as `0`, `1.0` as `1`, and `1e21` as `1e+21`, as in JavaScript.
- Python has no `undefined`. A key whose value is `None` is kept and sent as `null`.

## Test

`python3 -m unittest test_interop -v` starts a real Pactwire (JavaScript, via `start-pactwire.mjs`) and Python agents, then runs paid, refunded and verifier-checked deals between them. It also checks `canonical()` byte for byte against Node and verifies the whole log in Python.
