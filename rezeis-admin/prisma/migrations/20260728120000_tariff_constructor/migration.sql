CREATE TYPE "TariffConstructorModuleType" AS ENUM ('TRAFFIC', 'DEVICES');

CREATE TABLE "tariff_constructors" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL DEFAULT 'default',
  "is_enabled" BOOLEAN NOT NULL DEFAULT false,
  "draft_version" INTEGER NOT NULL DEFAULT 1,
  "base_plan_id" TEXT NOT NULL,
  "published_revision_id" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "tariff_constructors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tariff_constructors_draft_version_check" CHECK ("draft_version" > 0)
);

CREATE TABLE "tariff_constructor_durations" (
  "id" TEXT NOT NULL,
  "constructor_id" TEXT NOT NULL,
  "days" INTEGER NOT NULL,
  "currency" "Currency" NOT NULL,
  "base_amount" DECIMAL(20,8) NOT NULL,
  CONSTRAINT "tariff_constructor_durations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tariff_constructor_durations_days_check" CHECK ("days" > 0),
  CONSTRAINT "tariff_constructor_durations_base_amount_check" CHECK ("base_amount" >= 0)
);

CREATE TABLE "tariff_constructor_modules" (
  "id" TEXT NOT NULL,
  "constructor_id" TEXT NOT NULL,
  "type" "TariffConstructorModuleType" NOT NULL,
  "min_value" INTEGER NOT NULL,
  "max_value" INTEGER NOT NULL,
  "default_value" INTEGER NOT NULL,
  "step" INTEGER NOT NULL,
  CONSTRAINT "tariff_constructor_modules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tariff_constructor_modules_range_check" CHECK (
    "min_value" >= 0 AND
    "max_value" >= "min_value" AND
    "default_value" BETWEEN "min_value" AND "max_value" AND
    "step" > 0 AND
    (("max_value" - "min_value") % "step") = 0 AND
    (("default_value" - "min_value") % "step") = 0
  )
);

CREATE TABLE "tariff_constructor_module_prices" (
  "id" TEXT NOT NULL,
  "module_id" TEXT NOT NULL,
  "duration_id" TEXT NOT NULL,
  "amount" DECIMAL(20,8) NOT NULL,
  CONSTRAINT "tariff_constructor_module_prices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tariff_constructor_module_prices_amount_check" CHECK ("amount" >= 0)
);

CREATE TABLE "tariff_constructor_revisions" (
  "id" TEXT NOT NULL,
  "constructor_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "base_plan_id" TEXT NOT NULL,
  "published_by" TEXT,
  "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tariff_constructor_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tariff_constructor_revisions_version_check" CHECK ("version" > 0)
);

CREATE TABLE "tariff_constructor_revision_durations" (
  "id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "days" INTEGER NOT NULL,
  "currency" "Currency" NOT NULL,
  "base_amount" DECIMAL(20,8) NOT NULL,
  CONSTRAINT "tariff_constructor_revision_durations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tariff_constructor_revision_durations_days_check" CHECK ("days" > 0),
  CONSTRAINT "tariff_constructor_revision_durations_base_amount_check" CHECK ("base_amount" >= 0)
);

CREATE TABLE "tariff_constructor_revision_modules" (
  "id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "type" "TariffConstructorModuleType" NOT NULL,
  "min_value" INTEGER NOT NULL,
  "max_value" INTEGER NOT NULL,
  "default_value" INTEGER NOT NULL,
  "step" INTEGER NOT NULL,
  CONSTRAINT "tariff_constructor_revision_modules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tariff_constructor_revision_modules_range_check" CHECK (
    "min_value" >= 0 AND
    "max_value" >= "min_value" AND
    "default_value" BETWEEN "min_value" AND "max_value" AND
    "step" > 0 AND
    (("max_value" - "min_value") % "step") = 0 AND
    (("default_value" - "min_value") % "step") = 0
  )
);

CREATE TABLE "tariff_constructor_revision_module_prices" (
  "id" TEXT NOT NULL,
  "module_id" TEXT NOT NULL,
  "duration_id" TEXT NOT NULL,
  "amount" DECIMAL(20,8) NOT NULL,
  CONSTRAINT "tariff_constructor_revision_module_prices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tariff_constructor_revision_module_prices_amount_check" CHECK ("amount" >= 0)
);

CREATE UNIQUE INDEX "tariff_constructors_key_key" ON "tariff_constructors"("key");
CREATE UNIQUE INDEX "tariff_constructors_published_revision_id_key" ON "tariff_constructors"("published_revision_id");
CREATE INDEX "tariff_constructors_is_enabled_idx" ON "tariff_constructors"("is_enabled");
CREATE INDEX "tariff_constructors_base_plan_id_idx" ON "tariff_constructors"("base_plan_id");
CREATE UNIQUE INDEX "tariff_constructor_durations_constructor_id_days_currency_key" ON "tariff_constructor_durations"("constructor_id", "days", "currency");
CREATE INDEX "tariff_constructor_durations_constructor_id_idx" ON "tariff_constructor_durations"("constructor_id");
CREATE UNIQUE INDEX "tariff_constructor_modules_constructor_id_type_key" ON "tariff_constructor_modules"("constructor_id", "type");
CREATE INDEX "tariff_constructor_modules_constructor_id_idx" ON "tariff_constructor_modules"("constructor_id");
CREATE UNIQUE INDEX "tariff_constructor_module_prices_module_id_duration_id_key" ON "tariff_constructor_module_prices"("module_id", "duration_id");
CREATE INDEX "tariff_constructor_module_prices_duration_id_idx" ON "tariff_constructor_module_prices"("duration_id");
CREATE UNIQUE INDEX "tariff_constructor_revisions_constructor_id_version_key" ON "tariff_constructor_revisions"("constructor_id", "version");
CREATE INDEX "tariff_constructor_revisions_constructor_id_published_at_idx" ON "tariff_constructor_revisions"("constructor_id", "published_at");
CREATE UNIQUE INDEX "tariff_constructor_revision_durations_revision_id_days_currency_key" ON "tariff_constructor_revision_durations"("revision_id", "days", "currency");
CREATE INDEX "tariff_constructor_revision_durations_revision_id_idx" ON "tariff_constructor_revision_durations"("revision_id");
CREATE UNIQUE INDEX "tariff_constructor_revision_modules_revision_id_type_key" ON "tariff_constructor_revision_modules"("revision_id", "type");
CREATE INDEX "tariff_constructor_revision_modules_revision_id_idx" ON "tariff_constructor_revision_modules"("revision_id");
CREATE UNIQUE INDEX "tariff_constructor_revision_module_prices_module_id_duration_id_key" ON "tariff_constructor_revision_module_prices"("module_id", "duration_id");
CREATE INDEX "tariff_constructor_revision_module_prices_duration_id_idx" ON "tariff_constructor_revision_module_prices"("duration_id");

ALTER TABLE "tariff_constructors" ADD CONSTRAINT "tariff_constructors_base_plan_id_fkey" FOREIGN KEY ("base_plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tariff_constructor_durations" ADD CONSTRAINT "tariff_constructor_durations_constructor_id_fkey" FOREIGN KEY ("constructor_id") REFERENCES "tariff_constructors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tariff_constructor_modules" ADD CONSTRAINT "tariff_constructor_modules_constructor_id_fkey" FOREIGN KEY ("constructor_id") REFERENCES "tariff_constructors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tariff_constructor_module_prices" ADD CONSTRAINT "tariff_constructor_module_prices_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "tariff_constructor_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tariff_constructor_module_prices" ADD CONSTRAINT "tariff_constructor_module_prices_duration_id_fkey" FOREIGN KEY ("duration_id") REFERENCES "tariff_constructor_durations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tariff_constructor_revisions" ADD CONSTRAINT "tariff_constructor_revisions_constructor_id_fkey" FOREIGN KEY ("constructor_id") REFERENCES "tariff_constructors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tariff_constructor_revision_durations" ADD CONSTRAINT "tariff_constructor_revision_durations_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "tariff_constructor_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tariff_constructor_revision_modules" ADD CONSTRAINT "tariff_constructor_revision_modules_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "tariff_constructor_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tariff_constructor_revision_module_prices" ADD CONSTRAINT "tariff_constructor_revision_module_prices_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "tariff_constructor_revision_modules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tariff_constructor_revision_module_prices" ADD CONSTRAINT "tariff_constructor_revision_module_prices_duration_id_fkey" FOREIGN KEY ("duration_id") REFERENCES "tariff_constructor_revision_durations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tariff_constructors" ADD CONSTRAINT "tariff_constructors_published_revision_id_fkey" FOREIGN KEY ("published_revision_id") REFERENCES "tariff_constructor_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION prevent_tariff_constructor_revision_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'published tariff constructor revisions are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tariff_constructor_revisions_immutable BEFORE UPDATE OR DELETE ON "tariff_constructor_revisions" FOR EACH ROW EXECUTE FUNCTION prevent_tariff_constructor_revision_mutation();
CREATE TRIGGER tariff_constructor_revision_durations_immutable BEFORE UPDATE OR DELETE ON "tariff_constructor_revision_durations" FOR EACH ROW EXECUTE FUNCTION prevent_tariff_constructor_revision_mutation();
CREATE TRIGGER tariff_constructor_revision_modules_immutable BEFORE UPDATE OR DELETE ON "tariff_constructor_revision_modules" FOR EACH ROW EXECUTE FUNCTION prevent_tariff_constructor_revision_mutation();
CREATE TRIGGER tariff_constructor_revision_module_prices_immutable BEFORE UPDATE OR DELETE ON "tariff_constructor_revision_module_prices" FOR EACH ROW EXECUTE FUNCTION prevent_tariff_constructor_revision_mutation();
