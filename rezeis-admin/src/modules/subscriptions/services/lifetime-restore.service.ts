import { Injectable, Logger } from '@nestjs/common';
import {
  AddOnEntitlementActorType,
  AddOnEntitlementState,
  AddOnLifetime,
  EntitlementIncidentKind,
  Prisma,
  SubscriptionStatus,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { GIB_BYTES } from '../../add-on-entitlements/domain/cutover-baseline';
import { EffectiveProjectionService } from '../../add-on-entitlements/services/effective-projection.service';
import { SubscriptionTermHooksService } from '../../add-on-entitlements/services/subscription-term-hooks.service';
import type { AlignTailResult } from '../../add-on-entitlements/services/subscription-term.service';
import type { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { refundedSoFarSql } from '../../business-analytics/utils/analytics-money-received.util';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { isRetryableTransactionConflict } from '../../referrals/services/referral-qualification.service';

/**
 * «Подписки» → «Инструменты» → «Бессрочные подписки с датой» → «Вернуть
 * бессрочность» (owner, 24.09.2026).
 *
 * ── What went wrong ──────────────────────────────────────────────────────────
 *
 * Until 0.9.7.70 a subscription sold with NO end date (`expiresAt = null`) got a
 * Remnawave profile dated "now + 30 days", and the first read-back — the
 * webhook, «Импорт из Remnawave», ↻, a backup re-import's overlay, the cleanup's
 * heal — copied that date onto the row. The wire is fixed (the 31.12.2099
 * sentinel, `remnawave/services/panel-expiry.ts`), but a row that was already
 * re-dated looks like any dated row. The census below finds them; the operator
 * restores each one by hand. Nothing is restored automatically.
 *
 * ── The owner's decisions (final) ────────────────────────────────────────────
 *
 *  1. DELETED subscriptions are not listed and not restored: their profile is
 *     gone, and bringing one back is «Выдать подписку».
 *  2. Add-ons bought «до конца подписки» that ENDED at the wrong date come back:
 *     they were sold "until the end", which for this subscription is never.
 *  3. No customer notice of any kind.
 *  4. A refunded purchase never comes back: a row whose "no end" purchase was
 *     refunded or charged back is neither listed nor restored, unless a paid
 *     one stands beside it (`refundedWithoutEndSql`).
 *
 * ── One restore, in one transaction per subscription ─────────────────────────
 *
 * Under the row lock: refuse a missing, DELETED or already-open row; re-check
 * the evidence for THIS row (the operator's list may be stale) and refuse one
 * whose "no end" purchase was refunded since; then remove the
 * date, lift EXPIRED to ACTIVE (it expired only by the wrong date — DISABLED and
 * LIMITED keep theirs), let the term model follow (the tail term becomes
 * open-ended and so do the live add-ons that ended with it), bring back the
 * add-ons that ended at the wrong date and count them again, write one audit
 * row and — for a linked row — one ordinary UPDATE, queued after the commit.
 * One id's failure never stops the rest, and nothing is written for it.
 */

/** The audit action a restore writes, one row per restored subscription. */
export const LIFETIME_RESTORED_AUDIT_ACTION = 'user.subscription.lifetime_restored';

/**
 * `cause` and `payload.source` of the one UPDATE a restore queues for a linked
 * row. Built from the columns when it runs like every push, so it carries
 * 31.12.2099 (`toPanelExpireAt`); no status is sent — Remnawave lifts a profile
 * it EXPIRED by the old date to ACTIVE by itself once the date is in the
 * future, and a DISABLED profile stays DISABLED.
 */
export const LIFETIME_RESTORE_CAUSE = 'LIFETIME_RESTORE';

/** The reason on every add-on event a restore writes: a tail re-timing or a revival. */
export const LIFETIME_RESTORED_REASON = 'LIFETIME_RESTORED';

/** Census rows per answer; one more is read to tell a cut list. */
export const LIFETIME_CENSUS_LIMIT = 1000;

/** Subscriptions per restore request. */
export const LIFETIME_RESTORE_MAX_IDS = 200;

/** Attempts one subscription gets when PostgreSQL aborts its transaction to break a conflict. */
const RESTORE_ATTEMPTS = 3;

/**
 * WHAT THE BOUNDARY SWEEP LEAVES ON AN ADD-ON IT ENDED — the only shapes a
 * revival matches (`EntitlementBoundaryService.expireDueForSubscription` and the
 * device reduction's completion):
 *  - every type: `BEGIN_EXPIRY` (ACTIVE → EXPIRING), event reason
 *    `BOUNDARY_EXPIRY`, `expiresAt` left as it was — the date the sweep aligned
 *    it to, which for an add-on sold «до конца подписки» is the subscription's;
 *  - traffic: completed in the same pass — EXPIRED, `terminalReason`
 *    `TRAFFIC_BOUNDARY_EXPIRY`, `terminalAt` the sweep's clock;
 *  - devices: EXPIRING until the device reduction completes it — EXPIRED,
 *    `DEVICE_REDUCTION_VERIFIED` or `DEVICE_REDUCTION_NOT_APPLICABLE`.
 * A refund ends an add-on differently: it records a REFUND_OR_CHARGEBACK
 * incident first, and a device add-on it began expiring completes as REVERSED.
 */
const BOUNDARY_BEGIN_REASON = 'BOUNDARY_EXPIRY';
const BOUNDARY_COMPLETION_REASONS: readonly string[] = [
  'TRAFFIC_BOUNDARY_EXPIRY',
  'DEVICE_REDUCTION_VERIFIED',
  'DEVICE_REDUCTION_NOT_APPLICABLE',
];

// ── The wire (the SPA is written against these; see X-BC's API contract) ────

export type LifetimeEvidence =
  /** The row's own plan snapshot records "no end" (-1 days). */
  | { readonly kind: 'snapshot' }
  /** A completed payment for it, not refunded in full, was for -1 days. */
  | { readonly kind: 'payment'; readonly paymentId: string }
  /** A completed combined renewal's line for it was -1 days, and the renewal was not refunded in full. */
  | { readonly kind: 'paymentLine'; readonly paymentId: string }
  /** Its plan sells no duration other than -1. */
  | { readonly kind: 'plan'; readonly planId: string };

export interface LifetimeCensusRow {
  readonly subscriptionId: string;
  readonly userId: string;
  readonly userName: string | null;
  /** Decimal string. */
  readonly userTelegramId: string | null;
  readonly planName: string | null;
  /** ACTIVE | DISABLED | LIMITED | EXPIRED — never DELETED. */
  readonly status: string;
  /** The date it carries now. */
  readonly expiresAt: string;
  readonly createdAt: string;
  /** Has a Remnawave link: a restore then queues one sync. */
  readonly linked: boolean;
  readonly evidence: readonly LifetimeEvidence[];
  /** Hint: the date is a CREATE's completion + 30 days (±1 day) — the old defect's fingerprint. */
  readonly thirtyDaysAfterCreate: boolean;
  /** Hint: a completed payment for a real duration came after the last "no end" one — the date may be paid for. */
  readonly datedPaymentAfter: boolean;
  /** `thirtyDaysAfterCreate && !datedPaymentAfter` — the SPA pre-selects exactly these. */
  readonly suggested: boolean;
}

export interface LifetimeCensusResponse {
  /** Status, then `expiresAt` ascending; at most {@link LIFETIME_CENSUS_LIMIT}. */
  readonly rows: readonly LifetimeCensusRow[];
  readonly total: number;
  readonly truncated: boolean;
}

export type LifetimeRestoreOutcome =
  /** End date removed; EXPIRED → ACTIVE; term open-ended; ended add-ons back; one sync queued (if linked). */
  | 'restored'
  /** It already has no end date — nothing done (a second press). */
  | 'alreadyLifetime'
  /** Nothing shows any more that it was sold without an end — refused. */
  | 'notEligible'
  /**
   * What sold it without an end was refunded or charged back, and no paid
   * "no end" purchase stands beside it — refused: a refunded purchase never
   * comes back (owner's rule).
   */
  | 'refunded'
  /** DELETED subscriptions are not restored. */
  | 'deleted'
  | 'notFound'
  /** An unexpected error; nothing was written for this id (message in `error`). */
  | 'failed';

export interface LifetimeRestoreResult {
  readonly subscriptionId: string;
  readonly outcome: LifetimeRestoreOutcome;
  readonly previousExpiresAt: string | null;
  readonly statusBefore: string | null;
  readonly statusAfter: string | null;
  readonly revivedAddOns: number;
  readonly syncQueued: boolean;
  readonly error: string | null;
}

export interface LifetimeRestoreResponse {
  readonly results: readonly LifetimeRestoreResult[];
}

/** Who pressed the button, as the audit row records them. */
export interface LifetimeRestoreActor {
  readonly id: string;
}

/**
 * What became of the term model on a restore, as the audit row records it.
 *  - `ALIGNED` / `UNCHANGED`: in the model; the tail term is open-ended now
 *    (`UNCHANGED`: it already was).
 *  - `NOT_IN_MODEL`: the subscription never had a term (stage 1 was off for
 *    it); it stays outside, and it has no add-on rows to bring back.
 *  - `NO_ACTIVE_TERM`: it has terms but none is ACTIVE. The boundary sweep never
 *    closes a term — only a successor's activation and a deletion do — so a live
 *    row cannot get here through the product. Such a row stays on the column
 *    path, as every writer leaves it: `ensureTermInTransaction` mints nothing
 *    beside existing terms, and nothing counts an add-on without an ACTIVE term.
 */
type LifetimeTermOutcome =
  | {
      readonly outcome: 'ALIGNED';
      readonly termId: string;
      readonly previousEndsAt: string | null;
      readonly retimedAddOnIds: readonly string[];
    }
  | { readonly outcome: 'UNCHANGED'; readonly termId: string }
  | { readonly outcome: 'NOT_IN_MODEL' }
  | { readonly outcome: 'NO_ACTIVE_TERM' };

/** The row as the restore reads it, under its lock. */
interface LockedSubscription {
  readonly id: string;
  readonly userId: string;
  readonly status: SubscriptionStatus;
  readonly expiresAt: Date | null;
  readonly remnawaveId: string | null;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
}

/** One piece of evidence as the SQL hands it over. */
interface EvidenceSqlRow {
  readonly kind: string;
  readonly ref: string | null;
}

/** One census row as the SQL hands it over. */
interface CensusSqlRow {
  readonly subscriptionId: string;
  readonly userId: string;
  readonly userName: string | null;
  readonly userTelegramId: string | null;
  readonly planName: string | null;
  readonly status: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly linked: boolean;
  readonly evidence: unknown;
  readonly thirtyDaysAfterCreate: boolean;
  readonly datedPaymentAfter: boolean;
  readonly total: bigint;
}

/** What one restore transaction wrote, and the UPDATE to hand to the queue after its commit. */
interface RestoreWrite {
  readonly result: LifetimeRestoreResult;
  readonly syncJobId: string | null;
}

/**
 * THE PAYMENT WAS REFUNDED OR CHARGED BACK IN FULL — as the reversal
 * (`PaymentReconciliationService.reverseFulfilledPayment`, every door: the
 * provider's notice, the panel's «Вернуть», «Отметить возврат») leaves it,
 * WHATEVER ITS STATUS SAYS NOW:
 *  - its own stamp, `refundReversedAt`;
 *  - its refund ledger reaching what was paid — `refundedAmountTotal` at least
 *    the `amount` of a payment of more than nothing, `refundedInFullAt`'s rule
 *    (`payment-reconciliation.service.ts`). An older build's «Мой налог» write
 *    erased the stamp on most full refunds; the ledger, written before it,
 *    survived;
 *  - CANCELED after fulfilment applied it — a checkout abandoned before it was
 *    paid is CANCELED too, but was never applied;
 *  - REFUNDED, the status an older build gave a refund.
 * WHATEVER ITS STATUS: before 962aecf7 (19.09.2026) a success notification
 * replayed or retried after a full refund revived the payment to COMPLETED and
 * ran its hooks again, stamp and ledger kept (review R3b-01). The money went
 * back all the same, so such a payment proves nothing was PAID: the paid arms
 * of {@link lifetimeEvidenceSql} leave it out, and {@link refundedWithoutEndSql}
 * counts it as the refund it was.
 * A PARTIAL refund leaves the payment COMPLETED and the purchase standing
 * (`handleRefundReversal`), so it is not one.
 */
const REFUNDED_IN_FULL = Prisma.sql`(
  t."gateway_data" ->> 'refundReversedAt' IS NOT NULL
  OR (t."amount" > 0 AND ${refundedSoFarSql('t')} >= t."amount")
  OR (t."status" = 'CANCELED' AND t."fulfilled_at" IS NOT NULL)
  OR t."status" = 'REFUNDED'
)`;

/**
 * EVERY PIECE OF EVIDENCE THAT A SUBSCRIPTION WAS SOLD WITHOUT AN END — one row
 * per piece: its `kind`, the payment or plan it names (`ref`) and, for a
 * payment, when it was made (`paidAt`). W4's census (R1-01), validated on
 * seeded rows; any one piece is enough:
 *  - the row's own plan snapshot records the duration -1;
 *  - a COMPLETED payment for it records -1 (a PENDING, REFUNDED or FAILED one
 *    proves nothing was sold, and neither does one refunded in full, COMPLETED
 *    or not — {@link REFUNDED_IN_FULL});
 *  - a COMPLETED combined renewal's line for it has -1 days, the renewal not
 *    refunded in full;
 *  - the plan its snapshot names sells no duration other than -1.
 * `onlySubscriptionId` narrows every branch to one row: the restore's re-check
 * under the lock reads exactly what the census read, for that row.
 */
function lifetimeEvidenceSql(onlySubscriptionId: string | null): Prisma.Sql {
  const only = (column: Prisma.Sql): Prisma.Sql =>
    onlySubscriptionId === null ? Prisma.empty : Prisma.sql`AND ${column} = ${onlySubscriptionId}`;
  return Prisma.sql`
    SELECT s."id" AS "subscriptionId", 'snapshot'::text AS "kind", NULL::text AS "ref", NULL::timestamptz AS "paidAt"
      FROM "subscriptions" s
     WHERE s."plan_snapshot" ->> 'selectedDurationDays' = '-1'
       ${only(Prisma.sql`s."id"`)}
    UNION ALL
    SELECT t."subscription_id", 'payment', t."payment_id", t."created_at"
      FROM "transactions" t
     WHERE t."status" = 'COMPLETED'
       AND NOT ${REFUNDED_IN_FULL}
       AND t."subscription_id" IS NOT NULL
       AND t."plan_snapshot" ->> 'selectedDurationDays' = '-1'
       ${only(Prisma.sql`t."subscription_id"`)}
    UNION ALL
    SELECT i."subscription_id", 'paymentLine', t."payment_id", t."created_at"
      FROM "transaction_items" i
      JOIN "transactions" t ON t."id" = i."transaction_id"
     WHERE t."status" = 'COMPLETED'
       AND NOT ${REFUNDED_IN_FULL}
       AND i."duration_days" = -1
       ${only(Prisma.sql`i."subscription_id"`)}
    UNION ALL
    SELECT s."id", 'plan', s."plan_snapshot" ->> 'id', NULL::timestamptz
      FROM "subscriptions" s
     WHERE EXISTS (SELECT 1 FROM "plan_durations" d WHERE d."plan_id" = s."plan_snapshot" ->> 'id')
       AND NOT EXISTS (
             SELECT 1 FROM "plan_durations" d
              WHERE d."plan_id" = s."plan_snapshot" ->> 'id' AND d."days" <> -1)
       ${only(Prisma.sql`s."id"`)}
  `;
}

/** The evidence that a "no end" purchase was PAID for, and stands (never a payment refunded in full). */
const PAID_EVIDENCE_KINDS: readonly LifetimeEvidence['kind'][] = ['payment', 'paymentLine'];

/**
 * EVERY SUBSCRIPTION WHOSE "NO END" PURCHASE WAS REFUNDED — keyed on that
 * purchase itself: the payment for it that recorded -1 days, or a combined
 * renewal whose line for it had -1 days, refunded or charged back in full
 * ({@link REFUNDED_IN_FULL}). A refund of any other payment of the subscription
 * — a dated renewal, an add-on — says nothing about "no end" and is not here.
 * The owner's rule: a refunded purchase never comes back. The census and the
 * restore's re-check both keep such a row out unless a PAID "no end" purchase
 * stands beside it ({@link PAID_EVIDENCE_KINDS}) — bought again after the
 * refund, say. A lifetime an operator granted has no payment to refund.
 */
function refundedWithoutEndSql(onlySubscriptionId: string | null): Prisma.Sql {
  const only = (column: Prisma.Sql): Prisma.Sql =>
    onlySubscriptionId === null ? Prisma.empty : Prisma.sql`AND ${column} = ${onlySubscriptionId}`;
  return Prisma.sql`
    SELECT t."subscription_id" AS "subscriptionId"
      FROM "transactions" t
     WHERE t."subscription_id" IS NOT NULL
       AND t."plan_snapshot" ->> 'selectedDurationDays' = '-1'
       AND ${REFUNDED_IN_FULL}
       ${only(Prisma.sql`t."subscription_id"`)}
    UNION
    SELECT i."subscription_id"
      FROM "transaction_items" i
      JOIN "transactions" t ON t."id" = i."transaction_id"
     WHERE i."duration_days" = -1
       AND ${REFUNDED_IN_FULL}
       ${only(Prisma.sql`i."subscription_id"`)}
  `;
}

/**
 * THE CENSUS: every live (not DELETED) subscription that carries a date and has
 * evidence it was sold without one — unless what sold it was refunded and no
 * paid "no end" purchase stands beside it ({@link refundedWithoutEndSql}) —
 * with its customer, its evidence and two hints — never filters, the operator
 * decides:
 *  - `thirtyDaysAfterCreate`: the date is a completed CREATE's completion + 30
 *    days, ±1 day — what the old CREATE gave the profile, the re-dating's own
 *    fingerprint (any CREATE: a re-provision sent thirty days as well);
 *  - `datedPaymentAfter`: a completed payment for a real duration came after
 *    the last "no end" one, so the date may be paid for (a renewal made while
 *    the row carried a date).
 * `total` is the whole population, whatever the limit cut.
 */
function lifetimeCensusSql(limit: number): Prisma.Sql {
  return Prisma.sql`
    WITH "evidence" AS (${lifetimeEvidenceSql(null)}),
    "redated" AS (
      SELECT s."id",
             s."user_id",
             s."status",
             s."expires_at",
             s."created_at",
             s."remnawave_id",
             NULLIF(s."plan_snapshot" ->> 'name', '') AS "planName",
             jsonb_agg(DISTINCT jsonb_build_object('kind', e."kind", 'ref', e."ref")) AS "evidence",
             max(e."paidAt") AS "lastPaidWithoutEnd"
        FROM "subscriptions" s
        JOIN "evidence" e ON e."subscriptionId" = s."id"
       WHERE s."expires_at" IS NOT NULL
         AND s."status" <> 'DELETED'
       GROUP BY s."id"
      HAVING bool_or(e."kind" IN (${Prisma.join(PAID_EVIDENCE_KINDS)}))
          OR NOT EXISTS (
               SELECT 1 FROM (${refundedWithoutEndSql(null)}) AS rf WHERE rf."subscriptionId" = s."id")
    )
    SELECT r."id" AS "subscriptionId",
           r."user_id" AS "userId",
           NULLIF(u."name", '') AS "userName",
           u."telegram_id"::text AS "userTelegramId",
           r."planName",
           r."status"::text AS "status",
           r."expires_at" AS "expiresAt",
           r."created_at" AS "createdAt",
           r."remnawave_id" IS NOT NULL AS "linked",
           r."evidence",
           EXISTS (
             SELECT 1 FROM "profile_sync_jobs" j
              WHERE j."subscription_id" = r."id"
                AND j."action" = 'CREATE'
                AND j."status" = 'COMPLETED'
                AND r."expires_at" BETWEEN j."completed_at" + interval '29 days'
                                       AND j."completed_at" + interval '31 days'
           ) AS "thirtyDaysAfterCreate",
           EXISTS (
             SELECT 1 FROM "transactions" t
              WHERE t."subscription_id" = r."id"
                AND t."status" = 'COMPLETED'
                AND (t."plan_snapshot" ->> 'selectedDurationDays') IS NOT NULL
                AND t."plan_snapshot" ->> 'selectedDurationDays' <> '-1'
                AND t."created_at" > coalesce(r."lastPaidWithoutEnd", '-infinity'::timestamptz)
           ) AS "datedPaymentAfter",
           count(*) OVER () AS "total"
      FROM "redated" r
      JOIN "users" u ON u."id" = r."user_id"
     ORDER BY r."status", r."expires_at", r."id"
     LIMIT ${limit}
  `;
}

const EVIDENCE_ORDER: Readonly<Record<LifetimeEvidence['kind'], number>> = {
  snapshot: 0,
  payment: 1,
  paymentLine: 2,
  plan: 3,
};

/** The SQL's evidence rows as the wire has them: typed, one per piece, in a stable order. */
function readEvidence(rows: readonly EvidenceSqlRow[]): LifetimeEvidence[] {
  const evidence: LifetimeEvidence[] = [];
  for (const row of rows) {
    if (row.kind === 'snapshot') evidence.push({ kind: 'snapshot' });
    else if (row.kind === 'payment' && row.ref !== null) evidence.push({ kind: 'payment', paymentId: row.ref });
    else if (row.kind === 'paymentLine' && row.ref !== null) evidence.push({ kind: 'paymentLine', paymentId: row.ref });
    else if (row.kind === 'plan' && row.ref !== null) evidence.push({ kind: 'plan', planId: row.ref });
  }
  const refOf = (item: LifetimeEvidence): string =>
    item.kind === 'snapshot' ? '' : item.kind === 'plan' ? item.planId : item.paymentId;
  return evidence.sort(
    (left, right) =>
      EVIDENCE_ORDER[left.kind] - EVIDENCE_ORDER[right.kind] || refOf(left).localeCompare(refOf(right)),
  );
}

/** `jsonb_agg` of `{ kind, ref }` — anything else in it is dropped rather than trusted. */
function readAggregatedEvidence(value: unknown): LifetimeEvidence[] {
  if (!Array.isArray(value)) return [];
  return readEvidence(
    value.flatMap((entry: unknown) => {
      if (entry === null || typeof entry !== 'object') return [];
      const record = entry as Record<string, unknown>;
      return typeof record['kind'] === 'string'
        ? [{ kind: record['kind'], ref: typeof record['ref'] === 'string' ? record['ref'] : null }]
        : [];
    }),
  );
}

function toCensusRow(row: CensusSqlRow): LifetimeCensusRow {
  return {
    subscriptionId: row.subscriptionId,
    userId: row.userId,
    userName: row.userName,
    userTelegramId: row.userTelegramId,
    planName: row.planName,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    linked: row.linked,
    evidence: readAggregatedEvidence(row.evidence),
    thirtyDaysAfterCreate: row.thirtyDaysAfterCreate,
    datedPaymentAfter: row.datedPaymentAfter,
    suggested: row.thirtyDaysAfterCreate && !row.datedPaymentAfter,
  };
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** The first line of an error, bounded — what the operator reads next to the row. */
function describeFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const firstLine = text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'Unknown error';
  return firstLine.length > 300 ? `${firstLine.slice(0, 300)}…` : firstLine;
}

@Injectable()
export class LifetimeRestoreService {
  private readonly logger = new Logger(LifetimeRestoreService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly termHooks: SubscriptionTermHooksService,
    private readonly projections: EffectiveProjectionService,
    private readonly profileSyncQueue: ProfileSyncQueueService,
  ) {}

  /** The list the tab shows. Read-only. */
  public async census(limit: number = LIFETIME_CENSUS_LIMIT): Promise<LifetimeCensusResponse> {
    const rows = await this.prismaService.$queryRaw<CensusSqlRow[]>(lifetimeCensusSql(limit + 1));
    const kept = rows.slice(0, limit);
    const total = rows.length === 0 ? 0 : Number(rows[0]!.total);
    return { rows: kept.map(toCensusRow), total, truncated: rows.length > limit };
  }

  /**
   * «Вернуть бессрочность» for each id, in order, each in its own transaction.
   * One id's failure never stops the rest: it answers `failed` with its message,
   * and its transaction wrote nothing.
   */
  public async restore(
    subscriptionIds: readonly string[],
    admin: LifetimeRestoreActor,
    request: RequestMetadataInterface,
  ): Promise<LifetimeRestoreResponse> {
    const results: LifetimeRestoreResult[] = [];
    for (const subscriptionId of subscriptionIds) {
      results.push(await this.restoreOne(subscriptionId, admin, request));
    }
    return { results };
  }

  private async restoreOne(
    subscriptionId: string,
    admin: LifetimeRestoreActor,
    request: RequestMetadataInterface,
  ): Promise<LifetimeRestoreResult> {
    let written: RestoreWrite;
    try {
      written = await this.inOwnTransaction((tx) => this.restoreInTransaction(tx, subscriptionId, admin, request));
    } catch (error: unknown) {
      this.logger.error(
        `Lifetime restore of subscription ${subscriptionId} failed, nothing was written: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        subscriptionId,
        outcome: 'failed',
        previousExpiresAt: null,
        statusBefore: null,
        statusAfter: null,
        revivedAddOns: 0,
        syncQueued: false,
        error: describeFailure(error),
      };
    }
    if (written.syncJobId !== null) {
      try {
        await this.profileSyncQueue.enqueue(written.syncJobId);
      } catch (error: unknown) {
        // The job row is committed with the restore; the profile-sync sweep
        // recovers a PENDING one it finds, so a queue outage only delays it.
        this.logger.warn(
          `Lifetime restore of ${subscriptionId}: UPDATE ${written.syncJobId} not queued, the profile-sync sweep will: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return written.result;
  }

  /**
   * A deadlock or a serialization failure rolls the whole transaction back, so
   * it is run again from the start, a few times, before the id is `failed`.
   */
  private async inOwnTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prismaService.$transaction(work);
      } catch (error: unknown) {
        if (attempt < RESTORE_ATTEMPTS && isRetryableTransactionConflict(error)) continue;
        throw error;
      }
    }
  }

  private async restoreInTransaction(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    admin: LifetimeRestoreActor,
    request: RequestMetadataInterface,
  ): Promise<RestoreWrite> {
    // THE ROW LOCK FIRST — the order every term, add-on and payment writer
    // keeps — and every decision below reads the row as it is under it.
    const locked = await tx.$queryRaw<LockedSubscription[]>(Prisma.sql`
      SELECT "id",
             "user_id" AS "userId",
             "status"::text AS "status",
             "expires_at" AS "expiresAt",
             "remnawave_id" AS "remnawaveId",
             "traffic_limit" AS "trafficLimit",
             "device_limit" AS "deviceLimit"
        FROM "subscriptions"
       WHERE "id" = ${subscriptionId}
       FOR UPDATE
    `);
    const row = locked[0];
    if (row === undefined) return refused(subscriptionId, 'notFound', null);
    if (row.status === SubscriptionStatus.DELETED) return refused(subscriptionId, 'deleted', row);
    // THE SECOND PRESS: a row with no end is left exactly as it is — nothing
    // written, nothing pushed. Read as `Date | null` below on purpose: nothing
    // after this line leans on the check having narrowed it, so this one line
    // is the whole of what makes a second press write nothing.
    const previousExpiresAt: Date | null = row.expiresAt;
    if (previousExpiresAt === null) return refused(subscriptionId, 'alreadyLifetime', row);

    // THE EVIDENCE, AGAIN, FOR THIS ROW, under the lock. The operator's list was
    // read earlier and may be stale — the payment since refunded, the snapshot
    // rewritten by a plan assignment — and the client's list is never the
    // authority.
    const evidence = readEvidence(
      await tx.$queryRaw<EvidenceSqlRow[]>(
        Prisma.sql`SELECT e."kind", e."ref" FROM (${lifetimeEvidenceSql(subscriptionId)}) AS e`,
      ),
    );
    if (evidence.length === 0) return refused(subscriptionId, 'notEligible', row);
    // …AND WHAT SOLD IT WAS NOT REFUNDED — the census's own rule, for this row:
    // a snapshot or a plan still says "no end" after the money went back, and
    // a refunded purchase never comes back. A paid "no end" purchase beside it
    // (bought again after the refund) still stands.
    if (!evidence.some((item) => PAID_EVIDENCE_KINDS.includes(item.kind))) {
      const refundedPurchase = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT 1 FROM (${refundedWithoutEndSql(subscriptionId)}) AS rf LIMIT 1`,
      );
      if (refundedPurchase.length > 0) return refused(subscriptionId, 'refunded', row);
    }

    // NO END. EXPIRED only because of the wrong date, so it is ACTIVE again;
    // DISABLED (an operator's or Remnawave's switch-off) and LIMITED (out of
    // traffic) are statuses of their own and stay. The plan snapshot is not
    // touched: whatever it records about the duration stays.
    const liftsExpired = row.status === SubscriptionStatus.EXPIRED;
    const statusAfter = liftsExpired ? SubscriptionStatus.ACTIVE : row.status;
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: { expiresAt: null, ...(liftsExpired ? { status: SubscriptionStatus.ACTIVE } : {}) },
    });

    // THE TERM MODEL FOLLOWS: the tail term becomes open-ended, and so do the
    // PENDING/ACTIVE add-ons «до конца подписки» that ended with it
    // (`alignTailToExpiryInTransaction`), each move an event of its own.
    const correlationId = `lifetime-restore:${subscriptionId}`;
    const alignment = await this.termHooks.followExpiryInTransaction(tx, subscriptionId, {
      correlationId,
      actorType: AddOnEntitlementActorType.ADMIN,
      actorId: admin.id,
      reason: LIFETIME_RESTORED_REASON,
    });
    const term = await readTermOutcome(tx, subscriptionId, alignment);
    const inModel = term.outcome === 'ALIGNED' || term.outcome === 'UNCHANGED';

    // THE ADD-ONS THAT ENDED AT THE WRONG DATE COME BACK (owner's decision 2)…
    // …AND COUNT AGAIN: the projection sums ACTIVE add-ons, whatever term they
    // hang on, and the limit columns mirror it — what the next push sends —
    // exactly as an add-on's activation and expiry leave them.
    const revived = inModel
      ? await this.reviveEndedAddOnsInTransaction(tx, {
          subscriptionId,
          endedAt: previousExpiresAt,
          adminId: admin.id,
          correlationId,
        })
      : [];
    let limits: { readonly from: Prisma.InputJsonObject; readonly to: Prisma.InputJsonObject } | null = null;
    if (revived.length > 0) {
      const projection = await this.projections.recomputeInTransaction(tx, { subscriptionId, mode: 'ACTIVE' });
      if (projection.changed) {
        const mirrored = {
          trafficLimit:
            projection.desiredTrafficLimitBytes === null
              ? null
              : Number(projection.desiredTrafficLimitBytes / GIB_BYTES),
          deviceLimit: projection.desiredDeviceLimit === null ? 0 : projection.desiredDeviceLimit,
        };
        await tx.subscription.update({ where: { id: subscriptionId }, data: mirrored });
        limits = {
          from: { trafficLimit: row.trafficLimit, deviceLimit: row.deviceLimit },
          to: mirrored,
        };
      }
    }

    // ONE ordinary UPDATE for a linked row, the shape of the one-off "no end"
    // re-push (`ExpiredProfileCleanupService.reassertPanelNoEnd`): built from
    // the columns when it runs, so it carries 31.12.2099 and the limits above;
    // NO status. Its row is written in this transaction, so a restore never
    // commits without its push, and handed to the queue after the commit. An
    // unlinked row has no profile to tell, and creating one is «Выдать
    // подписку», not this.
    const syncJob =
      row.remnawaveId === null
        ? null
        : await tx.profileSyncJob.create({
            data: {
              subscriptionId,
              action: SyncAction.UPDATE,
              status: SyncJobStatus.PENDING,
              cause: LIFETIME_RESTORE_CAUSE,
              payload: { source: LIFETIME_RESTORE_CAUSE } as Prisma.InputJsonObject,
            },
            select: { id: true },
          });

    // ONE AUDIT ROW, in the same transaction as the restore it describes: the
    // admin, and the address and client every admin audit row records.
    const metadata = {
      requestId: request.requestId,
      subscriptionId,
      userId: row.userId,
      previousExpiresAt: isoOrNull(previousExpiresAt),
      statusBefore: row.status,
      statusAfter,
      evidence,
      revivedAddOnIds: revived,
      term,
      limits,
      syncJobId: syncJob === null ? null : syncJob.id,
    };
    await tx.adminAuditLog.create({
      data: {
        action: LIFETIME_RESTORED_AUDIT_ACTION,
        ipAddress: request.remoteAddress,
        userAgent: request.userAgent,
        metadata: metadata as Prisma.InputJsonObject,
        adminUser: { connect: { id: admin.id } },
      },
    });

    this.logger.log(
      `Lifetime restored for subscription ${subscriptionId} by admin ${admin.id}: was ${metadata.previousExpiresAt} ` +
        `(${row.status} → ${statusAfter}), term ${term.outcome}, ${revived.length} add-on(s) back, ` +
        (syncJob === null ? 'no push (unlinked)' : `UPDATE ${syncJob.id}`),
    );
    return {
      result: {
        subscriptionId,
        outcome: 'restored',
        previousExpiresAt: isoOrNull(previousExpiresAt),
        statusBefore: row.status,
        statusAfter,
        revivedAddOns: revived.length,
        syncQueued: syncJob !== null,
        error: null,
      },
      syncJobId: syncJob?.id ?? null,
    };
  }

  /**
   * The add-ons «до конца подписки» of this subscription that the boundary
   * sweep ENDED AT THE WRONG DATE — ended (EXPIRED) or ending (EXPIRING: a device
   * reduction under way, which a lifetime subscription no longer owes) — made
   * ACTIVE again with no end. Matched to exactly what the sweep leaves (see
   * {@link BOUNDARY_COMPLETION_REASONS}) and to the date being removed:
   *  - never one with a refund or chargeback on record — the customer has the
   *    money back, whatever state it is in; nor a REVERSED one (an operator's
   *    reversal, a refund's end) or one in REMEDIATION_REQUIRED;
   *  - never one that ended on a date of its own, earlier than the
   *    subscription's — it did not end BECAUSE of the wrong date;
   *  - never one sold «до следующего сброса»: that one ends at its reset.
   * The add-on stays on the term it was sold on: the projection counts an
   * ACTIVE add-on whatever term it hangs on, and the tail re-timing and every
   * sweep find it by subscription. The state machine has no way back from
   * EXPIRED (it ends there by design), so the revival is written here, the way
   * a tail alignment writes its re-timing: under the row's own version, with an
   * event of its own.
   */
  private async reviveEndedAddOnsInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly subscriptionId: string;
      readonly endedAt: Date | null;
      readonly adminId: string;
      readonly correlationId: string;
    },
  ): Promise<string[]> {
    const candidates = await tx.addOnEntitlement.findMany({
      where: {
        subscriptionId: input.subscriptionId,
        lifetime: AddOnLifetime.UNTIL_SUBSCRIPTION_END,
        expiresAt: input.endedAt,
        OR: [
          { state: AddOnEntitlementState.EXPIRED, terminalReason: { in: [...BOUNDARY_COMPLETION_REASONS] } },
          {
            state: AddOnEntitlementState.EXPIRING,
            events: { some: { toState: AddOnEntitlementState.EXPIRING, reason: BOUNDARY_BEGIN_REASON } },
          },
        ],
        incidents: { none: { kind: EntitlementIncidentKind.REFUND_OR_CHARGEBACK } },
      },
      orderBy: { id: 'asc' },
      select: { id: true, state: true, version: true, expiresAt: true, terminalReason: true, terminalAt: true },
    });
    const revived: string[] = [];
    for (const entitlement of candidates) {
      const claimed = await tx.addOnEntitlement.updateMany({
        where: { id: entitlement.id, state: entitlement.state, version: entitlement.version },
        data: {
          state: AddOnEntitlementState.ACTIVE,
          expiresAt: null,
          terminalAt: null,
          terminalReason: null,
          version: { increment: 1 },
        },
      });
      // Every writer of an add-on takes the subscription lock this holds, so a
      // lost claim is not expected; one that happens anyway owns the row now.
      if (claimed.count !== 1) continue;
      await tx.addOnEntitlementEvent.create({
        data: {
          entitlementId: entitlement.id,
          fromState: entitlement.state,
          toState: AddOnEntitlementState.ACTIVE,
          reason: LIFETIME_RESTORED_REASON,
          actorType: AddOnEntitlementActorType.ADMIN,
          actorId: input.adminId,
          correlationId: input.correlationId,
          // The version the revival produced: unique per add-on by construction.
          commandKey: `lifetime-restore:v${entitlement.version + 1}`,
          metadata: {
            subscriptionId: input.subscriptionId,
            previousExpiresAt: entitlement.expiresAt?.toISOString() ?? null,
            terminalReason: entitlement.terminalReason,
            terminalAt: entitlement.terminalAt?.toISOString() ?? null,
          },
        },
      });
      revived.push(entitlement.id);
    }
    return revived;
  }
}

function refused(
  subscriptionId: string,
  outcome: Exclude<LifetimeRestoreOutcome, 'restored' | 'failed'>,
  row: LockedSubscription | null,
): RestoreWrite {
  return {
    result: {
      subscriptionId,
      outcome,
      previousExpiresAt: row === null ? null : isoOrNull(row.expiresAt),
      statusBefore: row === null ? null : row.status,
      statusAfter: row === null ? null : row.status,
      revivedAddOns: 0,
      syncQueued: false,
      error: null,
    },
    syncJobId: null,
  };
}

/** The alignment's answer, as the audit row records it; see {@link LifetimeTermOutcome}. */
async function readTermOutcome(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
  alignment: AlignTailResult,
): Promise<LifetimeTermOutcome> {
  switch (alignment.outcome) {
    case 'ALIGNED':
      return {
        outcome: 'ALIGNED',
        termId: alignment.termId,
        previousEndsAt: alignment.previousEndsAt?.toISOString() ?? null,
        retimedAddOnIds: alignment.retimedEntitlementIds,
      };
    case 'UNCHANGED':
      return { outcome: 'UNCHANGED', termId: alignment.termId };
    case 'NOT_IN_MODEL': {
      const anyTerm = await tx.subscriptionTerm.findFirst({ where: { subscriptionId }, select: { id: true } });
      return { outcome: anyTerm === null ? 'NOT_IN_MODEL' : 'NO_ACTIVE_TERM' };
    }
    default:
      // Neither can answer here: the row was read under this lock and is not
      // DELETED, and an open end crosses no queued term. Thrown, so the whole
      // restore of this id rolls back rather than half-happening.
      throw new Error(`The term model refused the open end: ${alignment.outcome}`);
  }
}
