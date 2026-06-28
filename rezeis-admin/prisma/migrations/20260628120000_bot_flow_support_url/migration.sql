-- AlterEnum: add SUPPORT_URL screen-button action. A screen button with this
-- action opens a `t.me/<BOT_SUPPORT_USERNAME>?text=<prefill>` deep-link to the
-- operator's Telegram support account (handle + prefill resolved by reiwa at
-- render time from env / admin config). Idempotent so a re-run never fails.
ALTER TYPE "BotFlowButtonAction" ADD VALUE IF NOT EXISTS 'SUPPORT_URL';
