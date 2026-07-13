#!/usr/bin/env node
/**
 * Add-on entitlement grandfather cutover
 * ──────────────────────────────────────
 *
 * Backfills exactly one ACTIVE `SubscriptionTerm` and a SHADOW
 * `SubscriptionEffectiveProjection` for every existing non-deleted
 * subscription, derived from its current local limits. Additive and
 * observation-only: legacy fulfillment stays authoritative and NO upstream
 * (Remnawave) write happens. Idempotent — subscriptions that already have a
 * term are skipped, so re-running is safe.
 *
 * Usage
 *   node --require ts-node/register scripts/add-on-entitlement-cutover.ts          # dry-run (default): counts only
 *   node --require ts-node/register scripts/add-on-entitlement-cutover.ts --apply  # write terms + shadow projections
 *   ... --batch <n>                                                                # cap the batch size
 *
 * Environment
 *   DATABASE_URL must point at the target PostgreSQL instance.
 *
 * Production migration deploy is a later, explicit operator action — this
 * script never enables any feature flag or touches the panel.
 */
import { PrismaService } from '../src/common/prisma/prisma.service';
import { EffectiveProjectionService } from '../src/modules/add-on-entitlements/services/effective-projection.service';
import { EntitlementCutoverService } from '../src/modules/add-on-entitlements/services/entitlement-cutover.service';
import { SubscriptionTermService } from '../src/modules/add-on-entitlements/services/subscription-term.service';

function parseBatch(argv: readonly string[]): number | undefined {
  const idx = argv.indexOf('--batch');
  if (idx === -1) return undefined;
  const raw = argv[idx + 1];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const batchSize = parseBatch(process.argv);

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const service = new EntitlementCutoverService(
      prisma,
      new SubscriptionTermService(),
      new EffectiveProjectionService(),
    );
    const report = await service.runCutover({ dryRun: !apply, batchSize });
    // eslint-disable-next-line no-console -- standalone operator CLI, not the app runtime
    console.log(
      JSON.stringify(report, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- standalone operator CLI, not the app runtime
  console.error(error);
  process.exit(1);
});
