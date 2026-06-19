-- Usage-surface tracking on users.
-- `pwa_installed_at` is set once (first standalone/PWA open). `last_surface`
-- (tma/pwa/browser), `last_form_factor` (mobile/tablet/desktop) and `last_os`
-- (ios/android/windows/macos/linux/other) capture the most recent session's
-- surface; `last_seen_at` is the latest reported activity. All nullable; no
-- backfill.
ALTER TABLE "users" ADD COLUMN "pwa_installed_at" TIMESTAMPTZ(3);
ALTER TABLE "users" ADD COLUMN "last_surface" TEXT;
ALTER TABLE "users" ADD COLUMN "last_form_factor" TEXT;
ALTER TABLE "users" ADD COLUMN "last_os" TEXT;
ALTER TABLE "users" ADD COLUMN "last_seen_at" TIMESTAMPTZ(3);

CREATE INDEX "users_pwa_installed_at_idx" ON "users" ("pwa_installed_at");
CREATE INDEX "users_last_surface_idx" ON "users" ("last_surface");
CREATE INDEX "users_last_seen_at_idx" ON "users" ("last_seen_at");
