-- Two additions the Remnawave profile naming needs. The directory keeps the
-- first one's name: `docker-entrypoint.sh` lists this file by that name.
--
-- 1. "users": the Telegram @username as TELEGRAM reported it, and the Telegram
--    account it belongs to.
--
-- `users.username` cannot say whether it is the linked account's nick. The
-- bot's /start and the Mini App sign-in write it straight from Telegram, but
-- so do every donor importer (Bedolaga, Remnashop, AltShop and StealthNet copy
-- their own record of it; the Remnawave importer copies a foreign panel's
-- username into it) and the admin «create user» form (free text), and it
-- survives a Telegram rebind or an account merge naming the PREVIOUS account.
--
-- These two columns can. They are written together, and only by the
-- Telegram-verified bootstrap (`InternalUserEdgeService.bootstrapByTelegram`),
-- from the very update Telegram signed: the nick — NULL when the account has
-- none — and the Telegram id it belongs to. The nick counts only while
-- `telegram_username_tg_id` equals the row's current `telegram_id`: a rebind,
-- a link or a merge moves `telegram_id` and leaves the pair naming the old
-- account, which needs no clean-up anywhere. Existing rows start NULL and fill
-- on the customer's next /start or Mini App sign-in.
--
-- 2. "subscriptions": the name the last CREATE of a subscription chose for its
--    Remnawave profile, and the customer it chose it for.
--
-- Written BEFORE the POST that creates the profile, cleared when the CREATE
-- path links one. A CREATE whose link write failed, or whose POST answer was
-- lost, is retried — and the retry computes the name again from inputs that
-- may have moved in between (the @username is rewritten on every /start, an
-- operator edits the prefix, Telegram is unlinked, an account merge moves the
-- subscription). Asking the panel only for today's names then misses the
-- profile the first attempt made and mints a second one, which stays live with
-- the paid expiry and which the next Remnawave import turns into a second
-- subscription. The retry asks for the recorded name first. Not
-- `remnawave_panel_username`: that column is read as "linked to this profile".
--
-- Nullable, no default: catalogue changes, no table rewrite, and each pair in
-- ONE statement, so a pair is added together or not at all. `lock_timeout`
-- bounds the wait for the brief exclusive lock each change needs: behind a
-- long-running reader of either table it would otherwise queue every sign-in
-- or every purchase behind itself for as long as that reader runs. Timed out,
-- the next start replays this file (`is_auto_recoverable_migration` in
-- `docker-entrypoint.sh`), and `IF NOT EXISTS` makes the replay safe. The
-- setting is RESET at the end: `migrate deploy` applies every pending
-- migration over one connection, and a session setting left here would bind
-- the files after this one too.

SET lock_timeout = '5s';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "telegram_username" TEXT,
  ADD COLUMN IF NOT EXISTS "telegram_username_tg_id" BIGINT;

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "remnawave_pending_username" TEXT,
  ADD COLUMN IF NOT EXISTS "remnawave_pending_owner_id" TEXT;

RESET lock_timeout;
