-- CreateEnum
CREATE TYPE "BotButtonStyle" AS ENUM ('PRIMARY', 'SUCCESS', 'DANGER', 'DEFAULT');

-- CreateTable
CREATE TABLE "bot_buttons" (
    "id" TEXT NOT NULL,
    "button_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "style" "BotButtonStyle" NOT NULL DEFAULT 'PRIMARY',
    "icon_custom_emoji_id" TEXT,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "one_per_row" BOOLEAN NOT NULL DEFAULT false,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bot_buttons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_emojis" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "unicode" TEXT NOT NULL,
    "tg_emoji_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bot_emojis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_texts" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bot_texts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_buttons_button_id_key" ON "bot_buttons"("button_id");

-- CreateIndex
CREATE INDEX "bot_buttons_visible_order_index_idx" ON "bot_buttons"("visible", "order_index");

-- CreateIndex
CREATE UNIQUE INDEX "bot_emojis_key_key" ON "bot_emojis"("key");

-- CreateIndex
CREATE UNIQUE INDEX "bot_texts_key_key" ON "bot_texts"("key");

-- CreateIndex
CREATE INDEX "bot_texts_visible_idx" ON "bot_texts"("visible");
