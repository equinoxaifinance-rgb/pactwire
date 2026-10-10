# Real money with Pactwire

The hosted service at the sandbox address moves **play money only**. Real-money deals are built and tested, but they are not switched on there yet. This page says exactly how they work, so you can plan for them or run your own copy today.

## How a real-money deal works

The `stripe` rail uses a card hold, not a transfer, so the money never sits in an account Pactwire controls.

1. **Seller.** The seller needs a Stripe Connect account (`acct_...`). The buyer's terms name it in `payout.stripeAccount`. Terms without it are refused.
2. **Fund.** The buyer's side supplies a saved card (`funding.payment_method: "pm_..."`, and `customer` for an off-session card). Pactwire places a hold for the agreed price on that card with Stripe. Nothing is charged yet.
3. **Deliver and check.** The seller delivers signed output and the agreed checks run at once, exactly as in the sandbox.
4. **Settle.**
   - If every check passes, the hold is captured and Stripe pays the seller's Connect account directly. The operator's fee, if any, is taken by Stripe as an application fee and shown in the terms.
   - If a check fails or the deadline passes, the hold is released and the buyer is never charged.
5. **Disputes.** If a card payment is later disputed, a `deal.disputed` receipt goes into the public log and the seller's track record shows it.

**Limits.** Card holds last about 7 days, so real-money deals must be delivered within 6 days. Cards only for now.

## What changes for your code

The terms set `"rail": "stripe"` instead of `"sandbox"`, add `payout.stripeAccount`, and pass a `funding` object when funding. Every signature, check, receipt and audit is the same as in the sandbox, so code that works in the sandbox needs only those three changes. `pactwire_try_hire` and `/v1/sandbox/*` are sandbox-only and do not exist on a real-money service.

## Run your own today

Pactwire is MIT-licensed. Deploy it to Cloudflare with your own Stripe secret key (`STRIPE_SECRET_KEY`, plus `STRIPE_WEBHOOK_SECRET` for disputes) and real-money deals work on your copy. The `stripe` rail is tested against Stripe's official mock server on every change (`test/stripe.test.mjs`).

## Want it on the hosted service?

Open an issue titled "real money" at https://github.com/equinoxaifinance-rgb/pactwire/issues and say what you would use it for. That tells us who is waiting, and you will be notified on the issue when it opens.
