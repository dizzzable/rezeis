-- Creates the missing `faq_items` table to back the `FaqItem` Prisma
-- model. The model + controllers shipped without a corresponding
-- migration in earlier phases — this entry brings the DB schema in line
-- with the application code so `/admin/faq` can serve list/create/
-- update/delete requests.

CREATE TABLE "faq_items" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "media_url" TEXT,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "locale" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "faq_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "faq_items_is_active_order_index_idx" ON "faq_items"("is_active", "order_index");
CREATE INDEX "faq_items_locale_idx" ON "faq_items"("locale");
