-- Device signals on an anonymous support conversation, and the mark they raise.
--
-- ── The problem ───────────────────────────────────────────────────────────
--
-- Guest support is the one surface with no identity at all: a visitor opens a
-- conversation without logging in, and that is the point — it is the channel
-- somebody uses to appeal a ban, or to reach us when their account is broken.
--
-- It is also, for the same reason, the channel a banned person returns to. A
-- fresh incognito window is a fresh visitor; the per-IP limiter is a speed bump
-- and a captcha stops robots, not a motivated human. Nothing connected a guest
-- conversation to the ban that provoked it, so a single determined pest could
-- fill the queue that everybody else's real problems arrive in.
--
-- ── Why this does NOT refuse anybody by itself ────────────────────────────
--
-- Because the appeal from somebody blocked BY MISTAKE arrives on exactly this
-- path — as does the appeal from somebody an automation rule blocked at three
-- in the morning over a failed payment. Refusing on a device match would make
-- a wrong ban unappealable, which is a far worse failure than a noisy queue.
--
-- So a match sets `flagged_reason` and nothing else. The conversation opens,
-- the operator sees where it came from, and the decision to silence stays with
-- a person. That is the same call this product already made for device matches
-- on registration: mark, do not refuse.
--
-- The refusal, when it comes, is a MANUAL blocklist entry an operator adds
-- after judging one of these conversations — `blocked_identities` with
-- `kind = 'DEVICE_FP'` and `source = 'manual'`. Cascade-captured fingerprints,
-- which every blocked account produces automatically, deliberately do not
-- refuse: otherwise every ban would silently close the appeal door behind it.
--
-- ── What is collected, and when ───────────────────────────────────────────
--
-- Only at the moment a conversation is OPENED — never while somebody is
-- reading the site. The two values are the same ones the cabinet already
-- computes for signed-in visitors (`device_observations`): a random install id
-- kept in local storage, and a digest over what the graphics stack does. No raw
-- components are stored here either, so these columns cannot be read back into
-- a profile of anybody's machine.
--
-- ── Live safety ──────────────────────────────────────────────────────────
--
-- Three nullable columns and two indexes on `support_guests`. ADD COLUMN with
-- no default and no NOT NULL rewrites no rows; CREATE INDEX takes a brief
-- ACCESS SHARE-blocking lock on a table with at most a few days of rows in it
-- (guest records expire), bounded by `lock_timeout` rather than allowed to
-- queue behind a long transaction. Replay-safe throughout.
SET lock_timeout = '5s';

ALTER TABLE "support_guests" ADD COLUMN IF NOT EXISTS "install_id" TEXT;
ALTER TABLE "support_guests" ADD COLUMN IF NOT EXISTS "device_hash" TEXT;
ALTER TABLE "support_guests" ADD COLUMN IF NOT EXISTS "flagged_reason" TEXT;

CREATE INDEX IF NOT EXISTS "support_guests_device_hash_idx"
  ON "support_guests" ("device_hash");
CREATE INDEX IF NOT EXISTS "support_guests_install_id_idx"
  ON "support_guests" ("install_id");

COMMENT ON COLUMN "support_guests"."install_id" IS
  'Random per-install id from the browser, captured only when a conversation is opened.';
COMMENT ON COLUMN "support_guests"."device_hash" IS
  'Digest over the graphics stack — survives a cleared profile, is NOT unique to a person.';
COMMENT ON COLUMN "support_guests"."flagged_reason" IS
  'Why this conversation looks like it came from a blocked account. Sorts the queue; refuses nothing.';

RESET lock_timeout;
