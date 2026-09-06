-- AlterEnum: a quest for installing the cabinet as an app.
--
-- Detection reads `users.pwa_installed_at`, which the surface report already
-- stamps exactly once; no new column is needed.
--
-- IF NOT EXISTS keeps a re-run harmless, and `ALTER TYPE ... ADD VALUE` is the
-- same shape the gateway/currency enums have been extended with here before.
ALTER TYPE "QuestType" ADD VALUE IF NOT EXISTS 'INSTALL_PWA';
