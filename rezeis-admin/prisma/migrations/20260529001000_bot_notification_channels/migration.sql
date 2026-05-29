-- BotNotificationChannel — broadcast destination for SystemEvent-driven
-- notifications. Each row is a Telegram chat (group / channel / topic)
-- the operator wants the bot to forward events to. `kind_filter` is an
-- empty array when the row should receive every event.

CREATE TABLE "bot_notification_channels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "topic_thread_id" INTEGER,
    "kind_filter" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bot_notification_channels_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bot_notification_channels_is_active_idx"
    ON "bot_notification_channels" ("is_active");
