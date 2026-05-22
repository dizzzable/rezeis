-- Performance indexes for analytics and dashboard queries.
--
-- Composite indexes follow PostgreSQL best practice: equality columns first,
-- range columns last. This allows the planner to use index-only scans for
-- the most common analytics patterns (status = X AND updatedAt >= Y).

-- Transaction: analytics queries always filter by status + time range
CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions_status_updated_at_idx"
  ON "transactions" ("status", "updated_at" DESC);

-- Transaction: dashboard grossVolume aggregate
CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions_status_amount_idx"
  ON "transactions" ("status", "amount")
  WHERE "status" = 'COMPLETED';

-- Subscription: dashboard expiring-7d + churn computation
CREATE INDEX CONCURRENTLY IF NOT EXISTS "subscriptions_status_expires_at_idx"
  ON "subscriptions" ("status", "expires_at")
  WHERE "status" = 'ACTIVE';

-- Subscription: analytics funnel (status + isTrial)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "subscriptions_status_is_trial_idx"
  ON "subscriptions" ("status", "is_trial");

-- Subscription: churn computation (createdAt + status for eligible set)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "subscriptions_created_status_idx"
  ON "subscriptions" ("created_at", "status");

-- User: analytics new users in window
CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_created_at_desc_idx"
  ON "users" ("created_at" DESC);

-- RemnawaveMetricSample: trend queries always order by time
CREATE INDEX CONCURRENTLY IF NOT EXISTS "remnawave_metric_samples_created_at_desc_idx"
  ON "remnawave_metric_samples" ("created_at" DESC);
