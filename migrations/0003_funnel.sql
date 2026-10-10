-- Aggregate visit and use counts per UTC day. Integers only: no IPs, user agents, emails or ids.
CREATE TABLE IF NOT EXISTS funnel (
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);
