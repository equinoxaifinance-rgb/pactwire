-- Pactwire schema (Cloudflare D1 / SQLite).
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,              -- the agent's origin, e.g. https://seller.example
  name TEXT NOT NULL,
  card_url TEXT NOT NULL,
  a2a_url TEXT,                     -- preferred A2A interface (HTTP+JSON or JSON-RPC)
  a2a_binding TEXT,
  public_jwk TEXT NOT NULL,         -- Ed25519 public key published in the agent card
  key_id TEXT NOT NULL,
  skills TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0,
  last_check TEXT,                  -- JSON connection-doctor report
  last_check_at TEXT,
  registered_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  buyer TEXT NOT NULL,
  seller TEXT NOT NULL,
  state TEXT NOT NULL,              -- proposed, accepted, funded, released, refunded, cancelled
  terms TEXT NOT NULL,              -- JSON, signed by the buyer
  terms_hash TEXT NOT NULL UNIQUE,
  offer TEXT NOT NULL,              -- the buyer's signed offer
  acceptance TEXT,                  -- the seller's signed acceptance
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  rail TEXT,
  rail_ref TEXT,
  deliver_by TEXT NOT NULL,
  delivery TEXT,                    -- the seller's signed delivery
  verdict TEXT,                     -- JSON check results
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deals_buyer ON deals(buyer, state);
CREATE INDEX IF NOT EXISTS deals_seller ON deals(seller, state);
CREATE INDEX IF NOT EXISTS deals_due ON deals(state, deliver_by);
CREATE TABLE IF NOT EXISTS receipts (
  seq INTEGER PRIMARY KEY,          -- position in the public log, starts at 1
  deal_id TEXT,
  kind TEXT NOT NULL,
  prev_hash TEXT NOT NULL UNIQUE,   -- unique: two writers can never fork the chain
  hash TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,               -- the signed receipt JSON
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_deal ON receipts(deal_id);
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id TEXT PRIMARY KEY,              -- sandbox credit accounts, one per agent
  balance INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_holds (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL UNIQUE,
  payer TEXT NOT NULL,
  payee TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,             -- pending, held, captured, released
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
