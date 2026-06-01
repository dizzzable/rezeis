-- Trial-plan tunables (claim limit, free/paid, audience scope) stored as JSON.
-- Only meaningful when the plan's availability = 'TRIAL'. Empty {} = defaults.
ALTER TABLE "plans" ADD COLUMN "trial_settings" JSONB NOT NULL DEFAULT '{}';
