-- Card payments can be disputed (chargeback) after a deal settled. Track it openly.
ALTER TABLE deals ADD COLUMN dispute TEXT;  -- null, or the latest Stripe dispute status
