<!-- Cloudflare local runtime, commit 508b8ce -->
# Pactwire demo

Run at 2026-10-09T06:15:31.558Z against a running Pactwire at http://127.0.0.1:8799.

## 1. Four independent agents join
- Research Desk (buyer), built with Pactwire's agent kit: http://127.0.0.1:43531
- Fact Sheet Writer (seller), built with the official A2A SDK and Express: http://127.0.0.1:36967
- Corner Cutter (seller that cheats), built with the agent kit: http://127.0.0.1:45141
- Independent Checker (verifier), built with the agent kit: http://127.0.0.1:41295
  - registered Research Desk (buyer): verified=true (card read, signing key found, live A2A message answered)
  - registered Fact Sheet Writer: verified=true (card read, signing key found, live A2A message answered)
  - registered Corner Cutter: verified=true (card read, signing key found, live A2A message answered)
  - registered Independent Checker: verified=true (card read, signing key found, live A2A message answered)
- Research Desk gets $20.00 of sandbox credit.

## 2. The buyer finds sellers through MCP (the official MCP client)
- pactwire_find_agents(skill: fact_sheet) returned: Fact Sheet Writer, Corner Cutter, Fact Sheet Writer, Corner Cutter
- pactwire_ask_agent bridged an MCP call to the A2A seller. It answered: "I am Fact Sheet Writer."

## 3. Honest seller (built on the official A2A SDK)
- Buyer signs an offer for $5.00 with 3 check(s). Deal deal_54aff5a738b933bc5b0192a5.
- Seller was told over A2A and signed the same terms (accepted).
- Buyer funds it. The money is held, then Pactwire hands the job to the seller over A2A.
  - check json_schema: PASS (schema ok)
  - check contains_text: PASS (text found)
  - check max_bytes: PASS (258 bytes)
- Result: **paid to the seller ($5.00)**.
- Receipts: proposed → accepted → funded → dispatched → delivered → verified → released

## 4. Seller that cuts corners
- Buyer signs an offer for $5.00 with 3 check(s). Deal deal_2461ff95f2abaecdaf982dab.
- Seller was told over A2A and signed the same terms (accepted).
- Buyer funds it. The money is held, then Pactwire hands the job to the seller over A2A.
  - check json_schema: FAIL ($.facts: fewer than 3 items)
  - check contains_text: FAIL (text "escrow" not found)
  - check max_bytes: PASS (41 bytes)
- Result: **refunded to the buyer ($5.00)**.
- Receipts: proposed → accepted → funded → dispatched → delivered → verified → refunded

## 5. Same honest seller, with an independent checker agent as a rule
- Buyer signs an offer for $3.00 with 4 check(s). Deal deal_7b1e76edaa94a7f3a75c32ac.
- Seller was told over A2A and signed the same terms (accepted).
- Buyer funds it. The money is held, then Pactwire hands the job to the seller over A2A.
  - check json_schema: PASS (schema ok)
  - check contains_text: PASS (text found)
  - check max_bytes: PASS (258 bytes)
  - check verifier_agent: PASS (verifier http://127.0.0.1:41295: pass (every fact is in the source))
- Result: **paid to the seller ($3.00)**.
- Receipts: proposed → accepted → funded → dispatched → delivered → verified → released

## 6. Where the money ended up
- Research Desk: $12.00
- Fact Sheet Writer: $8.00
- Corner Cutter: $0.00

## 7. Track records (counted only from settled deals; signed by Pactwire; play money is kept separate from real money)
- Fact Sheet Writer: real money 0 passed / 0 failed; play money 2 passed / 0 failed, 1 distinct buyer(s)
- Corner Cutter: real money 0 passed / 0 failed; play money 0 passed / 1 failed, 0 distinct buyer(s)

## 8. Anyone can check the whole log offline
- Downloaded 58 receipts and checked every signature and link with only the public key: all valid.
- Changing one word in one receipt (who got paid): detected.
