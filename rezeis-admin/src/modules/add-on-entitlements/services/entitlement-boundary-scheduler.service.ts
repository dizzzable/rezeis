import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { readAddOnRolloutFlags } from '../add-on-rollout.config';
import { AddOnSwitchesService } from '../switches/add-on-switches.service';
import { DeviceReductionExecutionService } from './device-reduction-execution.service';
import { DeviceReductionPlanService } from './device-reduction-plan.service';
import { EntitlementBoundaryService } from './entitlement-boundary.service';
import { ResetBoundaryConfirmationService, resetAddOnHeldSql } from './reset-boundary-confirmation.service';
import { SubscriptionTermService, TERM_SHORTENED_ACROSS_SCHEDULED_TERM } from './subscription-term.service';

/** Max subscriptions swept for due boundaries per tick. */
const MAX_PER_TICK = 200;

/** Max subscriptions the hourly re-drive of parked device expiries takes. */
const MAX_PARKED_PER_RUN = 100;

/** Subscriptions the drift sweep aligns per run. */
const MAX_DRIFT_PER_RUN = 500;

/** One due subscription, as the selection hands it over. */
interface DueSubscription {
  readonly subscriptionId: string;
  readonly status: SubscriptionStatus;
}

/**
 * The device-reduction states that wait for an OPERATOR at the projection's
 * current revision. BLOCKED and REMEDIATION_REQUIRED always do — the automatic
 * executor never starts them (`AUTO_STARTABLE_STATES`). PENDING and IN_PROGRESS
 * do only while automatic cleanup is off: then a plan is approved by hand, and
 * re-planning it every tick asks the panel for the device list for nothing.
 */
function waitingForOperatorSql(autoCleanup: boolean): Prisma.Sql {
  return Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "subscription_effective_projections" p
      WHERE p."subscription_id" = e."subscription_id"
        AND (
          EXISTS (
            SELECT 1
            FROM "device_reduction_plans" d
            WHERE d."subscription_id" = p."subscription_id"
              AND d."projection_revision" = p."desired_revision"
              AND (
                d."state" IN ('BLOCKED', 'REMEDIATION_REQUIRED')
                OR (${autoCleanup} = false AND d."state" IN ('PENDING', 'IN_PROGRESS'))
              )
          )
          -- A refusal the planner raised an incident for (the dormancy conflict,
          -- an untrusted 2.x identity): only a person clears it, and re-planning
          -- it every tick would only ask the panel again.
          OR EXISTS (
            SELECT 1
            FROM "entitlement_incidents" i
            WHERE i."subscription_id" = p."subscription_id"
              AND i."kind" = 'DEVICE_REDUCTION_BLOCKED'
              AND i."state" <> 'RESOLVED'
              AND i."metadata"->>'projectionRevision' = p."desired_revision"::text
          )
        )
    )
  `;
}

/**
 * EntitlementBoundarySchedulerService (T-008)
 * ───────────────────────────────────────────
 * The authoritative local-time driver of add-on expiry. It finds every
 * subscription with a due boundary — an ACTIVE entitlement past its
 * `expiresAt`, a SCHEDULED term past its `startsAt`, a free limit bonus a paid
 * upgrade carried past its own end, an EXPIRING device entitlement still being
 * reduced — and runs the idempotent
 * {@link EntitlementBoundaryService} for each, enqueuing any profile-sync jobs
 * the boundary produced so the reduced desired limit propagates upstream.
 * Worker-only (`shouldRunSchedules`). A webhook-observed reset/expiry can
 * additionally trigger the SAME idempotent boundary at/after the planned
 * instant, but the scheduler guarantees convergence even if no webhook
 * arrives.
 *
 * ── Why the selection is ordered and split in two ──────────────────────────
 *
 * A tick takes at most {@link MAX_PER_TICK} subscriptions, and it used to take
 * them in no order at all, from one list mixing fresh boundaries with rows that
 * come back by design. A row that comes back every tick — an EXPIRING device
 * add-on waiting for an operator to approve its reduction, a DELETED row whose
 * recompute threw — could therefore fill the window, and a healthy add-on
 * behind them simply did not expire: the customer kept what they no longer
 * paid for. So:
 *
 *  1. FRESH boundaries first — ACTIVE entitlements and SCHEDULED terms that are
 *     due — ordered by the instant they fell due, then by subscription id.
 *     Nothing that re-enters can stand in front of them.
 *  2. RE-ENTRIES next, in the room left — EXPIRING device add-ons whose
 *     reduction is not finished — oldest first. Those WAITING FOR AN OPERATOR
 *     are PARKED out of this sweep entirely (see `waitingForOperatorSql`): with
 *     automatic cleanup on, a planned reduction is executed here and is never
 *     parked; with it off, a plan waits for its approval. A reduction the
 *     planner refused with an incident is parked either way. The parked rows
 *     are re-driven by {@link redriveParkedDeviceExpiries}, hourly and bounded,
 *     which is what notices a device list that shrank by itself.
 *
 * A DELETED subscription is not expired, it is retired
 * (`EntitlementBoundaryService.retireDeletedSubscription`): its add-ons
 * reversed, its terms closed, its projection DELETED — and it leaves the
 * selection for good.
 *
 * The same class also runs the DRIFT sweep ({@link alignDriftedTerms}): a tail
 * term whose end no longer matches `subscription.expiresAt` is aligned, so
 * «Мои опции» shows the date the add-on really ends on.
 */
@Injectable()
export class EntitlementBoundarySchedulerService {
  private readonly logger = new Logger(EntitlementBoundarySchedulerService.name);
  /** Where the drift sweep resumes; in memory, so a restart starts it over. */
  private driftCursor = '';

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly entitlementBoundaryService: EntitlementBoundaryService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly deviceReductionPlanService: DeviceReductionPlanService,
    private readonly deviceReductionExecutionService: DeviceReductionExecutionService,
    private readonly subscriptionTermService: SubscriptionTermService,
    /** The stage switches; `@Optional()` only for the specs that build this by hand. */
    @Optional() private readonly addOnSwitches?: AddOnSwitchesService,
    /**
     * Confirms Remnawave's reset before an add-on «до сброса» is taken off;
     * `@Optional()` only for the specs that build this by hand. Without it such
     * an add-on is simply held until the hold runs out.
     */
    @Optional() private readonly resetConfirmation?: ResetBoundaryConfirmationService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'entitlement-boundary-sweep' })
  public async sweep(): Promise<void> {
    if (!shouldRunSchedules()) return;
    const { subscriptions, enqueued } = await this.runDueBoundaries();
    if (subscriptions > 0) {
      this.logger.log(
        `Entitlement boundary sweep: processed ${subscriptions} subscription(s), enqueued ${enqueued} sync job(s)`,
      );
    }
  }

  /** Hourly: the device expiries the five-minute sweep parks. */
  @Cron('23 * * * *', { name: 'entitlement-boundary-parked-redrive' })
  public async redriveParked(): Promise<void> {
    if (!shouldRunSchedules()) return;
    const { subscriptions } = await this.redriveParkedDeviceExpiries();
    if (subscriptions > 0) {
      this.logger.log(`Parked device expiries re-driven: ${subscriptions} subscription(s)`);
    }
  }

  /** Hourly: terms whose end drifted from the subscription's expiry. */
  @Cron('41 * * * *', { name: 'entitlement-term-drift-sweep' })
  public async driftSweep(): Promise<void> {
    if (!shouldRunSchedules()) return;
    const { aligned, examined } = await this.alignDriftedTerms();
    if (examined > 0) {
      this.logger.log(`Term drift sweep: examined ${examined}, aligned ${aligned}`);
    }
  }

  public async runDueBoundaries(
    now: Date = new Date(),
  ): Promise<{ readonly subscriptions: number; readonly enqueued: number }> {
    const autoCleanup = (await readAddOnRolloutFlags(this.addOnSwitches)).deviceCleanupAuto;
    // FIRST, the resets Remnawave has confirmed: a boundary closed here makes
    // its add-ons due in the selection just below, in the same tick. A failed
    // pass holds nothing longer than its hold — the selection counts the hold
    // out on its own clock.
    if (this.resetConfirmation !== undefined) {
      try {
        await this.resetConfirmation.confirmDueBoundaries(now);
      } catch (err: unknown) {
        this.logger.warn(
          `Reset confirmation pass failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const fresh = await this.selectFreshDue(now, MAX_PER_TICK);
    const room = MAX_PER_TICK - fresh.length;
    const reentries =
      room > 0
        ? await this.selectDeviceReentries(now, room, {
            parked: false,
            autoCleanup,
            exclude: fresh.map((row) => row.subscriptionId),
          })
        : [];
    const due = [...fresh, ...reentries];
    const enqueued = await this.processAll(due, now, autoCleanup);
    return { subscriptions: due.length, enqueued };
  }

  /**
   * The device expiries parked out of {@link runDueBoundaries}, re-driven
   * through the same steps, oldest first and bounded.
   */
  public async redriveParkedDeviceExpiries(
    now: Date = new Date(),
  ): Promise<{ readonly subscriptions: number; readonly enqueued: number }> {
    const autoCleanup = (await readAddOnRolloutFlags(this.addOnSwitches)).deviceCleanupAuto;
    const parked = await this.selectDeviceReentries(now, MAX_PARKED_PER_RUN, {
      parked: true,
      autoCleanup,
      exclude: [],
    });
    const enqueued = await this.processAll(parked, now, autoCleanup);
    return { subscriptions: parked.length, enqueued };
  }

  /**
   * Aligns every tail term whose end drifted from `subscription.expiresAt`, in
   * subscription-id order from where the previous run stopped, each in its own
   * transaction through `SubscriptionTermService.alignTailToExpiryInTransaction`
   * (which is the one place the rule lives — the query below only finds the
   * candidates). One failing row is logged and skipped.
   *
   * The target the query compares against is the rule's own: `expiresAt` when
   * it is after the tail's start; one second after the start for an ACTIVE
   * tail it is not after; open for a lifetime row. A SCHEDULED tail that
   * `expiresAt` does not reach is an incident, not an alignment — such a row is
   * a candidate only until that incident exists and is not yet resolved.
   */
  public async alignDriftedTerms(): Promise<{ readonly examined: number; readonly aligned: number }> {
    const rows =await this.prismaService.$queryRaw<Array<{ readonly subscriptionId: string }>>(Prisma.sql`
      SELECT s."id" AS "subscriptionId"
      FROM "subscriptions" s
      JOIN "subscription_terms" a
        ON a."subscription_id" = s."id" AND a."status" = 'ACTIVE'
      LEFT JOIN LATERAL (
        SELECT q."id", q."starts_at", q."ends_at"
        FROM "subscription_terms" q
        WHERE q."subscription_id" = s."id" AND q."status" = 'SCHEDULED'
        ORDER BY q."generation" DESC
        LIMIT 1
      ) sched ON TRUE
      WHERE s."status" <> 'DELETED'
        AND s."id" > ${this.driftCursor}
        AND (
          CASE
            WHEN s."expires_at" IS NULL THEN
              COALESCE(sched."ends_at", a."ends_at") IS NOT NULL
            WHEN sched."id" IS NOT NULL AND s."expires_at" > sched."starts_at" THEN
              sched."ends_at" IS DISTINCT FROM s."expires_at"
            WHEN sched."id" IS NOT NULL THEN
              NOT EXISTS (
                SELECT 1
                FROM "entitlement_incidents" i
                WHERE i."subscription_id" = s."id"
                  AND i."summary_code" = ${TERM_SHORTENED_ACROSS_SCHEDULED_TERM}
                  AND i."state" <> 'RESOLVED'
              )
            WHEN s."expires_at" > a."starts_at" THEN
              a."ends_at" IS DISTINCT FROM s."expires_at"
            ELSE
              a."ends_at" IS DISTINCT FROM a."starts_at" + interval '1 second'
          END
        )
      ORDER BY s."id" ASC
      LIMIT ${MAX_DRIFT_PER_RUN}
    `);
    // Wrap around once the end is reached, so every drifted row is visited
    // whatever sits ahead of it.
    this.driftCursor = rows.length < MAX_DRIFT_PER_RUN ? '' : rows[rows.length - 1]!.subscriptionId;

    let aligned = 0;
    for (const row of rows) {
      try {
        const result = await this.prismaService.$transaction((tx) =>
          this.subscriptionTermService.alignTailToExpiryInTransaction(tx, row.subscriptionId, {
            correlationId: `term-drift:${row.subscriptionId}`,
          }),
        );
        if (result.outcome === 'ALIGNED') aligned += 1;
      } catch (err: unknown) {
        this.logger.warn(
          `Term alignment failed for ${row.subscriptionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { examined: rows.length, aligned };
  }

  /**
   * Fresh boundaries: ACTIVE entitlements past their end, SCHEDULED terms past
   * their start, and free limit bonuses a paid upgrade carried whose own end
   * (`until`, `term-limit-bonus.ts`) has passed on the ACTIVE term — one row
   * per subscription, the earliest due first. `until` is compared as the ISO
   * text it is written as (`toISOString`, always UTC), so a malformed value
   * can never fail the sweep's one query.
   *
   * An add-on HELD for Remnawave's reset (`resetAddOnHeldSql`) is not a fresh
   * boundary until its reset is confirmed or its hold runs out: a boundary that
   * never confirms would otherwise fill the window tick after tick, earliest
   * due and never taken, and nothing behind it would expire.
   */
  private selectFreshDue(now: Date, limit: number): Promise<DueSubscription[]> {
    return this.prismaService.$queryRaw<DueSubscription[]>(Prisma.sql`
      SELECT due."subscriptionId", s."status"::text AS "status"
      FROM (
        SELECT e."subscription_id" AS "subscriptionId", MIN(e."expires_at") AS "dueAt"
        FROM "add_on_entitlements" e
        LEFT JOIN "subscription_reset_epochs" ep ON ep."id" = e."expiry_epoch_id"
        WHERE e."state" = 'ACTIVE' AND e."expires_at" IS NOT NULL AND e."expires_at" <= ${now}
          AND NOT ${resetAddOnHeldSql(now)}
        GROUP BY e."subscription_id"
        UNION ALL
        SELECT t."subscription_id" AS "subscriptionId", MIN(t."starts_at") AS "dueAt"
        FROM "subscription_terms" t
        WHERE t."status" = 'SCHEDULED' AND t."starts_at" <= ${now}
        GROUP BY t."subscription_id"
        UNION ALL
        SELECT t."subscription_id" AS "subscriptionId", MIN(t."starts_at") AS "dueAt"
        FROM "subscription_terms" t
        WHERE t."status" = 'ACTIVE'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(t."plan_snapshot" -> 'limitBonuses') = 'array'
                  THEN t."plan_snapshot" -> 'limitBonuses'
                ELSE '[]'::jsonb
              END
            ) AS bonus
            WHERE jsonb_typeof(bonus -> 'until') = 'string'
              AND (bonus ->> 'until') <= ${now.toISOString()}
          )
        GROUP BY t."subscription_id"
      ) due
      JOIN "subscriptions" s ON s."id" = due."subscriptionId"
      GROUP BY due."subscriptionId", s."status"
      ORDER BY MIN(due."dueAt") ASC, due."subscriptionId" ASC
      LIMIT ${limit}
    `);
  }

  /**
   * Re-entries: subscriptions with EXPIRING add-ons past their end, oldest
   * first — those waiting for an operator (`parked: true`) or the rest.
   */
  private selectDeviceReentries(
    now: Date,
    limit: number,
    options: { readonly parked: boolean; readonly autoCleanup: boolean; readonly exclude: readonly string[] },
  ): Promise<DueSubscription[]> {
    const waiting = waitingForOperatorSql(options.autoCleanup);
    return this.prismaService.$queryRaw<DueSubscription[]>(Prisma.sql`
      SELECT e."subscription_id" AS "subscriptionId", s."status"::text AS "status"
      FROM "add_on_entitlements" e
      JOIN "subscriptions" s ON s."id" = e."subscription_id"
      WHERE e."state" = 'EXPIRING'
        AND e."expires_at" IS NOT NULL
        AND e."expires_at" <= ${now}
        AND NOT (e."subscription_id" = ANY(${[...options.exclude]}::text[]))
        AND ${
          options.parked
            ? Prisma.sql`(s."status" <> 'DELETED' AND ${waiting})`
            : Prisma.sql`(s."status" = 'DELETED' OR NOT ${waiting})`
        }
      GROUP BY e."subscription_id", s."status"
      ORDER BY MIN(e."expires_at") ASC, e."subscription_id" ASC
      LIMIT ${limit}
    `);
  }

  private async processAll(
    due: readonly DueSubscription[],
    now: Date,
    autoCleanup: boolean,
  ): Promise<number> {
    let enqueued = 0;
    for (const { subscriptionId, status } of due) {
      try {
        if (status === SubscriptionStatus.DELETED) {
          await this.entitlementBoundaryService.retireDeletedSubscription(subscriptionId);
          continue;
        }
        // Activate a due scheduled (renewal) term first, then expire due
        // entitlements — the term-start boundary and the old-term expiry may
        // coincide at the same tick.
        const activation = await this.entitlementBoundaryService.activateDueScheduledTerm(
          subscriptionId,
          now,
        );
        for (const syncJobId of activation.syncJobIds) {
          await this.profileSyncQueueService.enqueue(syncJobId);
          enqueued += 1;
        }

        const result = await this.entitlementBoundaryService.expireDueForSubscription(
          subscriptionId,
          now,
        );
        for (const syncJobId of result.syncJobIds) {
          await this.profileSyncQueueService.enqueue(syncJobId);
          enqueued += 1;
        }
        // A device-slot boundary just dropped the desired device limit. Planning
        // is re-entered for EXPIRING rows until it reaches a verified terminal
        // outcome; transient DEFERRED/BLOCKED results remain durably retryable.
        if (result.deviceExpiryTriggered) {
          const planning = await this.deviceReductionPlanService.planForSubscription(subscriptionId);
          if (planning.status === 'VERIFIED') {
            await this.entitlementBoundaryService.completeVerifiedDeviceExpiryForSubscription(
              subscriptionId,
              planning.projectionRevision,
              now,
            );
          } else if (planning.status === 'NOT_APPLICABLE' && planning.projectionRevision !== undefined) {
            // Nothing to reduce at this revision (unlimited devices, no panel
            // profile): the expiry is complete. Left EXPIRING, the row came
            // back every tick for a planning call that can only say the same.
            await this.entitlementBoundaryService.completeUnreducibleDeviceExpiryForSubscription(
              subscriptionId,
              planning.projectionRevision,
              planning.reason,
              now,
            );
          } else if (planning.status === 'PLANNED' && autoCleanup) {
            await this.deviceReductionExecutionService.executePlan(planning.planId);
          }
        }
      } catch (err: unknown) {
        // One subscription's failure must not abort the whole sweep.
        this.logger.warn(
          `Boundary processing failed for ${subscriptionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return enqueued;
  }
}
