-- Add the MONTH_ROLLING traffic reset strategy (Remnawave: reset monthly on the
-- profile's creation-date anniversary rather than a fixed calendar day).
-- PostgreSQL 17 allows ALTER TYPE ... ADD VALUE inside a transaction as long as
-- the new value is not used in the same transaction (we only add it here).
ALTER TYPE "TrafficLimitStrategy" ADD VALUE IF NOT EXISTS 'MONTH_ROLLING';
