-- Addresses an account has been seen from.
--
-- ── Why this is not "log every IP" ────────────────────────────────────────
--
-- This is a VPN product, and that inverts the usual reasoning. A customer
-- browsing the cabinet WHILE CONNECTED arrives from one of our own exit nodes,
-- and every customer behind that node arrives from the same address. Logging
-- those and grouping on them would build a map of who was on which node and
-- present it as a map of people: confident-looking, and mostly about us.
--
-- Mobile carriers do the same to their subscribers through CGNAT — thousands
-- behind one address in 100.64.0.0/10 — so a match there links strangers.
--
-- A row therefore exists only for an address `classifyCascadeIp` was willing to
-- attribute to a person: not one of our nodes, not carrier-grade NAT, not a
-- private or loopback range. The function that decides what a BAN may capture
-- decides what may be recorded here, because it is the same question asked
-- twice, and two answers to it would eventually disagree.
--
-- ── The failure that shapes the node check ────────────────────────────────
--
-- `getAllNodes()` answers `[]` on any failure. "We have no nodes" and "we could
-- not ask" therefore arrive as the same value, and treating the second as the
-- first means recording every node's exit address as though it belonged to the
-- customer who happened to be behind it. `classifyCascadeIp` already refuses on
-- an empty or absent node list for exactly this reason; nothing here may relax
-- that.
--
-- ── What it answers, and what it does not ─────────────────────────────────
--
-- One narrow question: has this address been seen on a blocked account? A match
-- MARKS a registration or a support conversation for an operator and refuses
-- nothing by itself. Households, offices and shared connections exist, so it
-- says "same place" and never "same person".
--
-- `hits` is what separates a home connection from a café somebody passed
-- through once — the difference between a match worth acting on and a
-- coincidence.
--
-- ── Live safety ──────────────────────────────────────────────────────────
--
-- A new table with a foreign key to `users`. CREATE TABLE takes no lock on
-- existing tables; the FK validation scan takes a SHARE ROW EXCLUSIVE on
-- `users`, bounded by `lock_timeout` rather than allowed to queue behind a long
-- transaction. Replay-safe throughout.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "user_ip_observations" (
  "id"            TEXT           NOT NULL,
  "user_id"       TEXT           NOT NULL,
  -- Canonical form, lower-cased, as `parseAddressOrCidr` produces — the same
  -- normalisation `blocked_ips` uses, so a value stored by one is findable by
  -- the other. Two spellings of one address would be two rows that never match.
  "address"       TEXT           NOT NULL,
  "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "hits"          INTEGER        NOT NULL DEFAULT 1,
  CONSTRAINT "user_ip_observations_pkey" PRIMARY KEY ("id")
);

-- One row per account per address; a repeat sighting bumps `hits` rather than
-- adding a row, which is what keeps the table proportional to places rather
-- than to page views.
CREATE UNIQUE INDEX IF NOT EXISTS "user_ip_observations_user_id_address_key"
  ON "user_ip_observations" ("user_id", "address");
-- The lookup: who else has been seen from this address.
CREATE INDEX IF NOT EXISTS "user_ip_observations_address_idx"
  ON "user_ip_observations" ("address");
-- Retention sweeps by age. These are movement traces, not a browser
-- fingerprint, and keeping them indefinitely is not something anybody asked for.
CREATE INDEX IF NOT EXISTS "user_ip_observations_last_seen_at_idx"
  ON "user_ip_observations" ("last_seen_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_ip_observations_user_id_fkey'
  ) THEN
    ALTER TABLE "user_ip_observations"
      ADD CONSTRAINT "user_ip_observations_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

COMMENT ON TABLE "user_ip_observations" IS
  'Addresses attributable to a person — our own node exits and CGNAT are excluded by classifyCascadeIp.';
COMMENT ON COLUMN "user_ip_observations"."hits" IS
  'Sessions that reported it. Separates a home connection from somewhere passed through once.';

RESET lock_timeout;
