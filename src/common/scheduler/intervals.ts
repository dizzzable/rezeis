/**
 * Scheduler intervals (inspired by remnawave backend-main).
 * Centralized cron expressions for all scheduled tasks.
 */
export const JOBS_INTERVALS = {
  // ── Subscription lifecycle ──────────────────────────────────────────────
  CHECK_EXPIRED_SUBSCRIPTIONS: '*/30 * * * * *', // every 30 seconds
  AUTO_RENEW_SUBSCRIPTIONS: '*/15 * * * *', // every 15 minutes

  // ── Traffic management ──────────────────────────────────────────────────
  RESET_USER_TRAFFIC_DAILY: '5 0 * * *', // 00:05 daily
  RESET_USER_TRAFFIC_WEEKLY: '15 0 * * 1', // Monday 00:15
  RESET_USER_TRAFFIC_MONTHLY: '20 0 1 * *', // 1st of month 00:20

  // ── Notifications ───────────────────────────────────────────────────────
  SEND_EXPIRY_NOTIFICATIONS: '0 */6 * * *', // every 6 hours
  SEND_LOW_BALANCE_WARNINGS: '0 9 * * *', // 09:00 daily

  // ── Cleanup ─────────────────────────────────────────────────────────────
  CLEANUP_EXPIRED_SESSIONS: '0 3 * * *', // 03:00 daily
  CLEANUP_OLD_WEBHOOK_EVENTS: '30 3 * * 0', // Sunday 03:30
  VACUUM_TABLES: '45 3 * * 1', // Monday 03:45

  // ── Backup ──────────────────────────────────────────────────────────────
  AUTO_BACKUP: '0 4 * * *', // 04:00 daily

  // ── Broadcast ───────────────────────────────────────────────────────────
  PROCESS_BROADCAST_QUEUE: '*/10 * * * * *', // every 10 seconds

  // ── Metrics ─────────────────────────────────────────────────────────────
  EXPORT_METRICS: '*/15 * * * * *', // every 15 seconds
} as const;
