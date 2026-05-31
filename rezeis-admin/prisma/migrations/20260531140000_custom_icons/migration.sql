-- Operator-uploaded custom icon library, reusable across the panel and the
-- reiwa cabinet. Array of `{ id, name, url, color }`.
ALTER TABLE "settings" ADD COLUMN "custom_icons" JSONB NOT NULL DEFAULT '[]';
