-- Drop bot_notification_channels — superseded by the
-- `mirrorUserNotifications` flag on the Telegram delivery config
-- (variant A: one Telegram delivery surface instead of a separate
-- broadcast-channels table). The table was only added in v0.5.1 and
-- never populated in practice, so the drop is safe.

DROP TABLE IF EXISTS "bot_notification_channels";
