-- Add AiInstruction table
CREATE TABLE "ai_instructions" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'app',
  "order_index" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ai_instructions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_instructions_slug_key" ON "ai_instructions"("slug");

-- Add ai_support_settings to Settings
ALTER TABLE "settings" ADD COLUMN "ai_support_settings" JSONB NOT NULL DEFAULT '{}';
