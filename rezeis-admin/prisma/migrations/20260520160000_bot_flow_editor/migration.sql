-- Bot Flow Editor: visual navigation graph for Telegram inline keyboards

-- Enums
CREATE TYPE "BotFlowStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "BotFlowButtonAction" AS ENUM ('NAVIGATE', 'URL', 'WEBAPP', 'CALLBACK', 'BACK', 'START_OVER');
CREATE TYPE "BotFlowButtonStyle" AS ENUM ('PRIMARY', 'SUCCESS', 'DANGER', 'DEFAULT');
CREATE TYPE "BotFlowParseMode" AS ENUM ('HTML', 'MARKDOWN', 'PLAIN');
CREATE TYPE "BotFlowMediaType" AS ENUM ('PHOTO', 'VIDEO', 'DOCUMENT', 'ANIMATION');

-- Bot Flows (versioned containers)
CREATE TABLE "bot_flows" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Main Flow',
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "BotFlowStatus" NOT NULL DEFAULT 'DRAFT',
    "layout_data" JSONB,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bot_flows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_flows_name_version_key" ON "bot_flows"("name", "version");
CREATE INDEX "bot_flows_status_idx" ON "bot_flows"("status");

-- Bot Flow Screens (nodes in the graph)
CREATE TABLE "bot_flow_screens" (
    "id" TEXT NOT NULL,
    "short_id" TEXT NOT NULL,
    "flow_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'New Screen',
    "text_ru" TEXT NOT NULL DEFAULT '',
    "text_en" TEXT NOT NULL DEFAULT '',
    "parse_mode" "BotFlowParseMode" NOT NULL DEFAULT 'HTML',
    "media_type" "BotFlowMediaType",
    "media_file_id" TEXT,
    "media_url" TEXT,
    "position_x" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "position_y" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "is_root" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bot_flow_screens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_flow_screens_flow_id_short_id_key" ON "bot_flow_screens"("flow_id", "short_id");
CREATE INDEX "bot_flow_screens_flow_id_idx" ON "bot_flow_screens"("flow_id");

-- Bot Flow Buttons (edges + actions)
CREATE TABLE "bot_flow_buttons" (
    "id" TEXT NOT NULL,
    "screen_id" TEXT NOT NULL,
    "label_ru" TEXT NOT NULL DEFAULT 'Кнопка',
    "label_en" TEXT NOT NULL DEFAULT 'Button',
    "row" INTEGER NOT NULL DEFAULT 0,
    "col" INTEGER NOT NULL DEFAULT 0,
    "action_type" "BotFlowButtonAction" NOT NULL,
    "target_screen_id" TEXT,
    "url" TEXT,
    "web_app_url" TEXT,
    "callback_action" TEXT,
    "style" "BotFlowButtonStyle" NOT NULL DEFAULT 'DEFAULT',
    "icon_custom_emoji_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bot_flow_buttons_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bot_flow_buttons_screen_id_idx" ON "bot_flow_buttons"("screen_id");

-- Foreign keys
ALTER TABLE "bot_flow_screens" ADD CONSTRAINT "bot_flow_screens_flow_id_fkey"
    FOREIGN KEY ("flow_id") REFERENCES "bot_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bot_flow_buttons" ADD CONSTRAINT "bot_flow_buttons_screen_id_fkey"
    FOREIGN KEY ("screen_id") REFERENCES "bot_flow_screens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
