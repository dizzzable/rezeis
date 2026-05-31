-- Optional icon for add-ons: a built-in lucide glyph key or `custom:<id>`
-- referencing the operator's custom icon library. Shown on the add-on card
-- in the reiwa cabinet; null falls back to a type-derived default.
ALTER TABLE "add_ons" ADD COLUMN "icon" TEXT;
