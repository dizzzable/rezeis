-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('DEV', 'ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('AR', 'AZ', 'BE', 'CS', 'DE', 'EN', 'ES', 'FA', 'FR', 'HE', 'HI', 'ID', 'IT', 'JA', 'KK', 'KO', 'MS', 'NL', 'PL', 'PT', 'RO', 'RU', 'SR', 'TR', 'UK', 'UZ', 'VI');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('USD', 'RUB', 'USDT', 'XTR', 'TON', 'BTC', 'ETH');

-- CreateEnum
CREATE TYPE "PaymentGatewayType" AS ENUM ('YOOKASSA', 'TELEGRAM_STARS', 'PLATEGA', 'HELEKET', 'CRYPTOMUS', 'MULENPAY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED', 'DELETED');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELED', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PurchaseType" AS ENUM ('NEW', 'RENEW', 'UPGRADE', 'ADDITIONAL');

-- CreateEnum
CREATE TYPE "PurchaseChannel" AS ENUM ('WEB', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('TRAFFIC', 'DEVICES', 'BOTH', 'UNLIMITED');

-- CreateEnum
CREATE TYPE "PlanAvailability" AS ENUM ('ALL', 'NEW', 'EXISTING', 'INVITED', 'ALLOWED', 'TRIAL');

-- CreateEnum
CREATE TYPE "ArchivedPlanRenewMode" AS ENUM ('SELF_RENEW', 'REPLACE_ON_RENEW');

-- CreateEnum
CREATE TYPE "TrafficLimitStrategy" AS ENUM ('NO_RESET', 'DAY', 'WEEK', 'MONTH');

-- CreateEnum
CREATE TYPE "AccessMode" AS ENUM ('PUBLIC', 'INVITED', 'PURCHASE_BLOCKED', 'REG_BLOCKED', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('ANDROID', 'IPHONE', 'WINDOWS', 'MAC', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentWebhookLifecycleStatus" AS ENUM ('RECEIVED', 'ENQUEUED', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "SyncAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'TRAFFIC_RESET');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('DRAFT', 'PROCESSING', 'COMPLETED', 'CANCELED', 'FAILED');

-- CreateEnum
CREATE TYPE "BroadcastAudience" AS ENUM ('ALL', 'ACTIVE_SUBSCRIBERS', 'EXPIRED', 'TRIAL', 'UNSUBSCRIBED');

-- CreateEnum
CREATE TYPE "BroadcastMessageStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED', 'CANCELED');

-- CreateEnum
CREATE TYPE "PromocodeRewardType" AS ENUM ('DURATION', 'TRAFFIC', 'DEVICES', 'SUBSCRIPTION', 'PERSONAL_DISCOUNT', 'PURCHASE_DISCOUNT');

-- CreateEnum
CREATE TYPE "PromocodeAvailability" AS ENUM ('ALL', 'NEW', 'EXISTING', 'INVITED', 'ALLOWED');

-- CreateEnum
CREATE TYPE "PromocodeActivationOutcome" AS ENUM ('ACTIVATED', 'SELECT_SUBSCRIPTION', 'CREATE_NEW', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReferralInviteSource" AS ENUM ('BOT', 'WEB', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ReferralRewardType" AS ENUM ('POINTS', 'EXTRA_DAYS');

-- CreateEnum
CREATE TYPE "PartnerLevel" AS ENUM ('LEVEL_1', 'LEVEL_2', 'LEVEL_3');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('DRAFT', 'DRY_RUN', 'COMMITTED', 'ROLLED_BACK', 'FAILED');

-- CreateEnum
CREATE TYPE "BackupScope" AS ENUM ('DB', 'ASSETS', 'FULL');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'WAITING_REPLY', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportTicketAuthorType" AS ENUM ('USER', 'ADMIN');

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "login_normalized" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'ADMIN',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "last_login_at" TIMESTAMPTZ(3),
    "last_login_ip" TEXT,
    "password_changed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "admin_user_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "telegram_id" BIGINT,
    "username" TEXT,
    "email" TEXT,
    "referral_code" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "language" "Locale" NOT NULL DEFAULT 'EN',
    "personal_discount" INTEGER NOT NULL DEFAULT 0,
    "purchase_discount" INTEGER NOT NULL DEFAULT 0,
    "points" INTEGER NOT NULL DEFAULT 0,
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "is_bot_blocked" BOOLEAN NOT NULL DEFAULT false,
    "is_rules_accepted" BOOLEAN NOT NULL DEFAULT true,
    "partner_balance_currency_override" "Currency",
    "max_subscriptions" INTEGER NOT NULL DEFAULT 1,
    "current_subscription_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trial_grants" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trial_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "web_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "login" TEXT,
    "login_normalized" TEXT,
    "email" TEXT,
    "email_normalized" TEXT,
    "email_verified_at" TIMESTAMPTZ(3),
    "password_hash" TEXT,
    "requires_password_change" BOOLEAN NOT NULL DEFAULT false,
    "temporary_password_expires_at" TIMESTAMPTZ(3),
    "credentials_bootstrapped_at" TIMESTAMPTZ(3),
    "link_prompt_snooze_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "web_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_challenges" (
    "id" TEXT NOT NULL,
    "web_account_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "code_hash" TEXT,
    "token_hash" TEXT,
    "attempts_left" INTEGER NOT NULL DEFAULT 5,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_trial" BOOLEAN NOT NULL DEFAULT false,
    "plan_snapshot" JSONB NOT NULL DEFAULT '{}',
    "traffic_limit" INTEGER,
    "device_limit" INTEGER NOT NULL DEFAULT 0,
    "internal_squads" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "external_squad" TEXT,
    "remnawave_id" TEXT,
    "config_url" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "device_type" "DeviceType",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_sync_jobs" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "action" "SyncAction" NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "scheduled_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "profile_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "type" "PlanType" NOT NULL DEFAULT 'BOTH',
    "availability" "PlanAvailability" NOT NULL DEFAULT 'ALL',
    "archived_renew_mode" "ArchivedPlanRenewMode" NOT NULL DEFAULT 'SELF_RENEW',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tag" TEXT,
    "traffic_limit" INTEGER,
    "device_limit" INTEGER NOT NULL DEFAULT 0,
    "traffic_limit_strategy" "TrafficLimitStrategy" NOT NULL DEFAULT 'NO_RESET',
    "upgrade_to_plan_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "replacement_plan_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "internal_squads" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "external_squad" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_durations" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "plan_durations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_prices" (
    "id" TEXT NOT NULL,
    "plan_duration_id" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "price" DECIMAL(20,8) NOT NULL,

    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_gateways" (
    "id" TEXT NOT NULL,
    "type" "PaymentGatewayType" NOT NULL,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "currency" "Currency" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_gateways_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "subscription_id" TEXT,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "purchase_type" "PurchaseType" NOT NULL,
    "channel" "PurchaseChannel" NOT NULL DEFAULT 'WEB',
    "gateway_type" "PaymentGatewayType" NOT NULL,
    "gateway_id" TEXT,
    "gateway_data" JSONB,
    "currency" "Currency" NOT NULL,
    "payment_asset" TEXT,
    "amount" DECIMAL(20,8) NOT NULL,
    "plan_snapshot" JSONB NOT NULL DEFAULT '{}',
    "device_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" TEXT NOT NULL,
    "gateway_type" "PaymentGatewayType" NOT NULL,
    "payment_id" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "event_status" TEXT,
    "status" "PaymentWebhookLifecycleStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "reconciliation_attempts" INTEGER NOT NULL DEFAULT 0,
    "replay_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "payload_hash" TEXT,
    "raw_payload" JSONB NOT NULL,
    "normalized_payload" JSONB,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "last_transition_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_replayed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "referrer_id" TEXT NOT NULL,
    "referred_id" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "invite_source" "ReferralInviteSource" NOT NULL DEFAULT 'UNKNOWN',
    "qualified_at" TIMESTAMPTZ(3),
    "qualified_transaction_id" TEXT,
    "qualified_purchase_channel" "PurchaseChannel",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_invites" (
    "id" TEXT NOT NULL,
    "inviter_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "note" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "referral_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "total_earned" INTEGER NOT NULL DEFAULT 0,
    "total_withdrawn" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_withdrawals" (
    "id" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "method" TEXT NOT NULL,
    "requisites" TEXT NOT NULL,
    "admin_comment" TEXT,
    "processed_by" TEXT,
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "partner_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" TEXT NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'DRAFT',
    "audience" "BroadcastAudience" NOT NULL DEFAULT 'ALL',
    "audience_plan_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_messages" (
    "id" TEXT NOT NULL,
    "broadcast_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "telegram_message_id" BIGINT,
    "status" "BroadcastMessageStatus" NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "broadcast_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notification_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_notification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "rules_required" BOOLEAN NOT NULL DEFAULT false,
    "channel_required" BOOLEAN NOT NULL DEFAULT false,
    "rules_link" TEXT NOT NULL DEFAULT '',
    "channel_id" BIGINT,
    "channel_link" TEXT NOT NULL DEFAULT '',
    "access_mode" "AccessMode" NOT NULL DEFAULT 'PUBLIC',
    "invite_mode_started_at" TIMESTAMPTZ(3),
    "default_currency" "Currency" NOT NULL DEFAULT 'RUB',
    "payment_ops_alerts" JSONB NOT NULL DEFAULT '{}',
    "system_notifications" JSONB NOT NULL DEFAULT '{}',
    "platform_policy" JSONB NOT NULL DEFAULT '{}',
    "user_notifications" JSONB NOT NULL DEFAULT '{}',
    "referral_settings" JSONB NOT NULL DEFAULT '{}',
    "partner_settings" JSONB NOT NULL DEFAULT '{}',
    "multi_subscription_settings" JSONB NOT NULL DEFAULT '{}',
    "branding_settings" JSONB NOT NULL DEFAULT '{}',
    "bot_menu_settings" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promocodes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "availability" "PromocodeAvailability" NOT NULL DEFAULT 'ALL',
    "reward_type" "PromocodeRewardType" NOT NULL,
    "reward" INTEGER,
    "plan" JSONB,
    "lifetime" INTEGER,
    "max_activations" INTEGER,
    "allowed_telegram_ids" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "allowed_plan_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "promocodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promocode_activations" (
    "id" TEXT NOT NULL,
    "promocode_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "promocode_code" TEXT NOT NULL,
    "reward_type" "PromocodeRewardType" NOT NULL,
    "reward_value" INTEGER NOT NULL DEFAULT 0,
    "target_subscription_id" TEXT,
    "activated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promocode_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_rewards" (
    "id" TEXT NOT NULL,
    "referral_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "ReferralRewardType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "is_issued" BOOLEAN NOT NULL DEFAULT false,
    "issued_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_transactions" (
    "id" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "referral_user_id" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "payment_amount" INTEGER NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,
    "earned_amount" INTEGER NOT NULL,
    "source_transaction_id" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "partner_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_referrals" (
    "id" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "referral_user_id" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "parent_partner_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "partner_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_records" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "scope" "BackupScope" NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum" TEXT,
    "delivery_channel" TEXT NOT NULL,
    "delivery_recipient" TEXT,
    "delivered_at" TIMESTAMPTZ(3),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_records" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'DRAFT',
    "records_total" INTEGER NOT NULL DEFAULT 0,
    "records_ok" INTEGER NOT NULL DEFAULT 0,
    "records_failed" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error_message" TEXT,
    "created_by" TEXT,
    "committed_at" TIMESTAMPTZ(3),
    "rolled_back_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "import_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_messages" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "author_type" "SupportTicketAuthorType" NOT NULL,
    "author_id" TEXT,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_login_normalized_key" ON "admin_users"("login_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX "admin_users_role_idx" ON "admin_users"("role");

-- CreateIndex
CREATE INDEX "admin_users_is_active_idx" ON "admin_users"("is_active");

-- CreateIndex
CREATE INDEX "admin_audit_log_action_idx" ON "admin_audit_log"("action");

-- CreateIndex
CREATE INDEX "admin_audit_log_admin_user_id_idx" ON "admin_audit_log"("admin_user_id");

-- CreateIndex
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_referral_code_key" ON "users"("referral_code");

-- CreateIndex
CREATE UNIQUE INDEX "users_current_subscription_id_key" ON "users"("current_subscription_id");

-- CreateIndex
CREATE INDEX "users_telegram_id_idx" ON "users"("telegram_id");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_is_blocked_idx" ON "users"("is_blocked");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "trial_grants_user_id_key" ON "trial_grants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "web_accounts_user_id_key" ON "web_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "web_accounts_login_key" ON "web_accounts"("login");

-- CreateIndex
CREATE UNIQUE INDEX "web_accounts_login_normalized_key" ON "web_accounts"("login_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "web_accounts_email_key" ON "web_accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "web_accounts_email_normalized_key" ON "web_accounts"("email_normalized");

-- CreateIndex
CREATE INDEX "auth_challenges_web_account_id_purpose_idx" ON "auth_challenges"("web_account_id", "purpose");

-- CreateIndex
CREATE INDEX "auth_challenges_destination_purpose_idx" ON "auth_challenges"("destination", "purpose");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_idx" ON "subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "subscriptions_expires_at_idx" ON "subscriptions"("expires_at");

-- CreateIndex
CREATE INDEX "subscriptions_is_trial_idx" ON "subscriptions"("is_trial");

-- CreateIndex
CREATE INDEX "subscriptions_created_at_idx" ON "subscriptions"("created_at");

-- CreateIndex
CREATE INDEX "profile_sync_jobs_subscription_id_idx" ON "profile_sync_jobs"("subscription_id");

-- CreateIndex
CREATE INDEX "profile_sync_jobs_status_idx" ON "profile_sync_jobs"("status");

-- CreateIndex
CREATE INDEX "profile_sync_jobs_action_idx" ON "profile_sync_jobs"("action");

-- CreateIndex
CREATE UNIQUE INDEX "plans_name_key" ON "plans"("name");

-- CreateIndex
CREATE INDEX "plans_is_active_idx" ON "plans"("is_active");

-- CreateIndex
CREATE INDEX "plans_is_archived_idx" ON "plans"("is_archived");

-- CreateIndex
CREATE INDEX "plans_availability_idx" ON "plans"("availability");

-- CreateIndex
CREATE INDEX "plans_order_index_idx" ON "plans"("order_index");

-- CreateIndex
CREATE INDEX "plan_durations_plan_id_idx" ON "plan_durations"("plan_id");

-- CreateIndex
CREATE INDEX "plan_prices_plan_duration_id_idx" ON "plan_prices"("plan_duration_id");

-- CreateIndex
CREATE INDEX "plan_prices_currency_idx" ON "plan_prices"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "plan_prices_plan_duration_id_currency_key" ON "plan_prices"("plan_duration_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateways_type_key" ON "payment_gateways"("type");

-- CreateIndex
CREATE INDEX "payment_gateways_is_active_idx" ON "payment_gateways"("is_active");

-- CreateIndex
CREATE INDEX "payment_gateways_order_index_idx" ON "payment_gateways"("order_index");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_payment_id_key" ON "transactions"("payment_id");

-- CreateIndex
CREATE INDEX "transactions_user_id_idx" ON "transactions"("user_id");

-- CreateIndex
CREATE INDEX "transactions_subscription_id_idx" ON "transactions"("subscription_id");

-- CreateIndex
CREATE INDEX "transactions_status_idx" ON "transactions"("status");

-- CreateIndex
CREATE INDEX "transactions_gateway_type_idx" ON "transactions"("gateway_type");

-- CreateIndex
CREATE INDEX "transactions_purchase_type_idx" ON "transactions"("purchase_type");

-- CreateIndex
CREATE INDEX "transactions_created_at_idx" ON "transactions"("created_at");

-- CreateIndex
CREATE INDEX "payment_webhook_events_gateway_type_idx" ON "payment_webhook_events"("gateway_type");

-- CreateIndex
CREATE INDEX "payment_webhook_events_status_idx" ON "payment_webhook_events"("status");

-- CreateIndex
CREATE INDEX "payment_webhook_events_payment_id_idx" ON "payment_webhook_events"("payment_id");

-- CreateIndex
CREATE INDEX "payment_webhook_events_provider_event_id_idx" ON "payment_webhook_events"("provider_event_id");

-- CreateIndex
CREATE INDEX "payment_webhook_events_payload_hash_idx" ON "payment_webhook_events"("payload_hash");

-- CreateIndex
CREATE INDEX "payment_webhook_events_received_at_idx" ON "payment_webhook_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_gateway_type_provider_event_id_key" ON "payment_webhook_events"("gateway_type", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referred_id_key" ON "referrals"("referred_id");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_qualified_transaction_id_key" ON "referrals"("qualified_transaction_id");

-- CreateIndex
CREATE INDEX "referrals_referrer_id_idx" ON "referrals"("referrer_id");

-- CreateIndex
CREATE INDEX "referrals_referred_id_idx" ON "referrals"("referred_id");

-- CreateIndex
CREATE INDEX "referrals_level_idx" ON "referrals"("level");

-- CreateIndex
CREATE INDEX "referrals_qualified_at_idx" ON "referrals"("qualified_at");

-- CreateIndex
CREATE UNIQUE INDEX "referral_invites_token_key" ON "referral_invites"("token");

-- CreateIndex
CREATE INDEX "referral_invites_inviter_id_idx" ON "referral_invites"("inviter_id");

-- CreateIndex
CREATE INDEX "referral_invites_token_idx" ON "referral_invites"("token");

-- CreateIndex
CREATE INDEX "referral_invites_expires_at_idx" ON "referral_invites"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "partners_user_id_key" ON "partners"("user_id");

-- CreateIndex
CREATE INDEX "partners_user_id_idx" ON "partners"("user_id");

-- CreateIndex
CREATE INDEX "partners_is_active_idx" ON "partners"("is_active");

-- CreateIndex
CREATE INDEX "partner_withdrawals_partner_id_idx" ON "partner_withdrawals"("partner_id");

-- CreateIndex
CREATE INDEX "partner_withdrawals_status_idx" ON "partner_withdrawals"("status");

-- CreateIndex
CREATE INDEX "partner_withdrawals_created_at_idx" ON "partner_withdrawals"("created_at");

-- CreateIndex
CREATE INDEX "broadcasts_status_idx" ON "broadcasts"("status");

-- CreateIndex
CREATE INDEX "broadcasts_audience_idx" ON "broadcasts"("audience");

-- CreateIndex
CREATE INDEX "broadcasts_created_at_idx" ON "broadcasts"("created_at");

-- CreateIndex
CREATE INDEX "broadcast_messages_broadcast_id_idx" ON "broadcast_messages"("broadcast_id");

-- CreateIndex
CREATE INDEX "broadcast_messages_user_id_idx" ON "broadcast_messages"("user_id");

-- CreateIndex
CREATE INDEX "broadcast_messages_status_idx" ON "broadcast_messages"("status");

-- CreateIndex
CREATE INDEX "user_notification_events_user_id_idx" ON "user_notification_events"("user_id");

-- CreateIndex
CREATE INDEX "user_notification_events_type_idx" ON "user_notification_events"("type");

-- CreateIndex
CREATE INDEX "user_notification_events_read_at_idx" ON "user_notification_events"("read_at");

-- CreateIndex
CREATE INDEX "user_notification_events_created_at_idx" ON "user_notification_events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "promocodes_code_key" ON "promocodes"("code");

-- CreateIndex
CREATE INDEX "promocodes_is_active_idx" ON "promocodes"("is_active");

-- CreateIndex
CREATE INDEX "promocodes_availability_idx" ON "promocodes"("availability");

-- CreateIndex
CREATE INDEX "promocodes_reward_type_idx" ON "promocodes"("reward_type");

-- CreateIndex
CREATE INDEX "promocodes_created_at_idx" ON "promocodes"("created_at");

-- CreateIndex
CREATE INDEX "promocode_activations_promocode_id_idx" ON "promocode_activations"("promocode_id");

-- CreateIndex
CREATE INDEX "promocode_activations_user_id_idx" ON "promocode_activations"("user_id");

-- CreateIndex
CREATE INDEX "promocode_activations_reward_type_idx" ON "promocode_activations"("reward_type");

-- CreateIndex
CREATE INDEX "promocode_activations_activated_at_idx" ON "promocode_activations"("activated_at");

-- CreateIndex
CREATE UNIQUE INDEX "promocode_activations_promocode_id_user_id_key" ON "promocode_activations"("promocode_id", "user_id");

-- CreateIndex
CREATE INDEX "referral_rewards_referral_id_idx" ON "referral_rewards"("referral_id");

-- CreateIndex
CREATE INDEX "referral_rewards_user_id_idx" ON "referral_rewards"("user_id");

-- CreateIndex
CREATE INDEX "referral_rewards_is_issued_idx" ON "referral_rewards"("is_issued");

-- CreateIndex
CREATE INDEX "partner_transactions_partner_id_idx" ON "partner_transactions"("partner_id");

-- CreateIndex
CREATE INDEX "partner_transactions_referral_user_id_idx" ON "partner_transactions"("referral_user_id");

-- CreateIndex
CREATE INDEX "partner_transactions_level_idx" ON "partner_transactions"("level");

-- CreateIndex
CREATE INDEX "partner_transactions_created_at_idx" ON "partner_transactions"("created_at");

-- CreateIndex
CREATE INDEX "partner_referrals_partner_id_idx" ON "partner_referrals"("partner_id");

-- CreateIndex
CREATE INDEX "partner_referrals_referral_user_id_idx" ON "partner_referrals"("referral_user_id");

-- CreateIndex
CREATE INDEX "partner_referrals_parent_partner_id_idx" ON "partner_referrals"("parent_partner_id");

-- CreateIndex
CREATE INDEX "partner_referrals_level_idx" ON "partner_referrals"("level");

-- CreateIndex
CREATE UNIQUE INDEX "partner_referrals_partner_id_referral_user_id_key" ON "partner_referrals"("partner_id", "referral_user_id");

-- CreateIndex
CREATE INDEX "backup_records_scope_idx" ON "backup_records"("scope");

-- CreateIndex
CREATE INDEX "backup_records_delivery_channel_idx" ON "backup_records"("delivery_channel");

-- CreateIndex
CREATE INDEX "backup_records_created_at_idx" ON "backup_records"("created_at");

-- CreateIndex
CREATE INDEX "import_records_source_type_idx" ON "import_records"("source_type");

-- CreateIndex
CREATE INDEX "import_records_status_idx" ON "import_records"("status");

-- CreateIndex
CREATE INDEX "import_records_created_at_idx" ON "import_records"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_type_key" ON "notification_templates"("type");

-- CreateIndex
CREATE INDEX "notification_templates_is_active_idx" ON "notification_templates"("is_active");

-- CreateIndex
CREATE INDEX "support_tickets_user_id_idx" ON "support_tickets"("user_id");

-- CreateIndex
CREATE INDEX "support_tickets_status_idx" ON "support_tickets"("status");

-- CreateIndex
CREATE INDEX "support_tickets_created_at_idx" ON "support_tickets"("created_at");

-- CreateIndex
CREATE INDEX "support_ticket_messages_ticket_id_idx" ON "support_ticket_messages"("ticket_id");

-- CreateIndex
CREATE INDEX "support_ticket_messages_created_at_idx" ON "support_ticket_messages"("created_at");

-- AddForeignKey
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_current_subscription_id_fkey" FOREIGN KEY ("current_subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_grants" ADD CONSTRAINT "trial_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_accounts" ADD CONSTRAINT "web_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_web_account_id_fkey" FOREIGN KEY ("web_account_id") REFERENCES "web_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_sync_jobs" ADD CONSTRAINT "profile_sync_jobs_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_durations" ADD CONSTRAINT "plan_durations_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_duration_id_fkey" FOREIGN KEY ("plan_duration_id") REFERENCES "plan_durations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_id_fkey" FOREIGN KEY ("referred_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_invites" ADD CONSTRAINT "referral_invites_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners" ADD CONSTRAINT "partners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_withdrawals" ADD CONSTRAINT "partner_withdrawals_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_messages" ADD CONSTRAINT "broadcast_messages_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notification_events" ADD CONSTRAINT "user_notification_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promocode_activations" ADD CONSTRAINT "promocode_activations_promocode_id_fkey" FOREIGN KEY ("promocode_id") REFERENCES "promocodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promocode_activations" ADD CONSTRAINT "promocode_activations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promocode_activations" ADD CONSTRAINT "promocode_activations_target_subscription_id_fkey" FOREIGN KEY ("target_subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "referrals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_transactions" ADD CONSTRAINT "partner_transactions_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_transactions" ADD CONSTRAINT "partner_transactions_referral_user_id_fkey" FOREIGN KEY ("referral_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_referrals" ADD CONSTRAINT "partner_referrals_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_referrals" ADD CONSTRAINT "partner_referrals_referral_user_id_fkey" FOREIGN KEY ("referral_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
