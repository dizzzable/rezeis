import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SubscriptionStatus, SyncJobStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { sameSquadSelection } from '../utils/plan-squads.util';

/** Marks a `ProfileSyncJob` row as belonging to a plan-squad propagation. */
export const PLAN_SQUAD_PROPAGATION_CAUSE = 'PLAN_SQUAD_UPDATE';

/**
 * How many of a propagation's jobs are pushed into BullMQ by the request that
 * created them. The rest stay `PENDING` in the database and are picked up by
 * `ProfileSyncQueueService.sweepAndRecover` (every 5 minutes, 100 rows a pass).
 *
 * The cap exists because a plan can have tens of thousands of subscribers and
 * the admin PATCH is a synchronous HTTP request: enqueuing every job inline
 * would hold the request open for the whole fan-out and dump the entire batch
 * on the panel at once. Deferring to the sweep costs latency on the tail and
 * nothing else — a PENDING row is the durable record, the BullMQ entry is only
 * a nudge (this is the same property `BulkPlanAssignmentService` relies on when
 * an enqueue throws).
 */
export const PLAN_SQUAD_PROPAGATION_ENQUEUE_LIMIT = 100;

/** Statuses whose panel profile is live enough to be worth pushing to now. */
const PUSHABLE_STATUSES: ReadonlySet<string> = new Set<string>([
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.LIMITED,
]);

export interface PlanSquadPropagationSummary {
  /** `null` when the write did not change the plan's squads (nothing queued). */
  readonly propagationId: string | null;
  readonly subscriptionsUpdated: number;
  /**
   * Subscriptions sold on this plan that were LEFT ALONE because their squads
   * no longer matched the plan's previous set.
   *
   * Skipping them is deliberate — an add-on grant, a manual panel fix or an
   * import that read live membership has diverged on purpose, and a plan edit
   * must not stomp it. Saying NOTHING about them was the defect.
   *
   * Without this number an operator who reworks squads is told "updated: 0" and
   * reads it as "everything was already correct", when it can equally mean "not
   * one subscription was moved". Those customers keep the old squad uuids; if
   * the old squads were deleted or recreated in Remnawave, every renewal then
   * fails with the panel's catch-all `A039 Update user error`, which names
   * neither the field nor the value. That is a long way to travel from a plan
   * edit that reported success.
   */
  readonly subscriptionsSkippedDiverged: number;
  readonly syncJobsCreated: number;
  /**
   * Subscriptions whose columns WERE rewritten but which got no push, because
   * they carry no panel identity to push with.
   *
   * Reported rather than implied by the gap between the two counts above: that
   * gap also contains the EXPIRED/DISABLED rows, which are a deliberate and
   * harmless deferral. This number is the other thing hiding in it — rows whose
   * panel profile is live and now disagrees with the database about which
   * squads the customer is in, with nothing scheduled to reconcile them.
   */
  readonly syncJobsSkippedUnlinked: number;
  /**
   * Subscriptions moved whose push is the RESET RULE's, because the same save
   * changed their rule too (review R4-02): the follow's push after their terms
   * moved, or the one written with the edit for a row outside the term model.
   * It reads the row whole and carries the new squads; a separate squad push
   * went out first and put the new rule in Remnawave ahead of the follow.
   */
  readonly pushedWithResetRule: number;
}

export interface PlanSquadPropagationStatus {
  readonly planId: string;
  readonly propagationId: string | null;
  readonly queuedAt: string | null;
  readonly total: number;
  readonly pending: number;
  readonly running: number;
  readonly failed: number;
  readonly completed: number;
  /** True when nothing is left to do — including "there was never anything". */
  readonly isComplete: boolean;
}

/** One subscriber of the plan, as the propagation statement leaves it. */
interface PropagationRow {
  readonly id: string;
  readonly status: string;
  /** Carries a Remnawave identity to push with. */
  readonly linked: boolean;
  /** Tracked the plan's previous squads, and was moved to the new ones. */
  readonly moved: boolean;
}

/**
 * Carries a plan's squad change to the subscriptions already sold on that plan.
 *
 * ── Why a fan-out and not "read squads from the snapshot" ──────────────────
 *
 * `PlanSnapshotSyncService` writes the edited plan's fields into every
 * subscriber's `plan_snapshot`, and `ProfileSyncProcessor` reads `tag` and
 * `trafficLimitStrategy` from there — so those two edits do eventually reach the
 * panel. Squads do not: the processor reads `activeInternalSquads` /
 * `externalSquadUuid` from the subscription's own COLUMNS
 * (`profile-sync.processor.ts` :514, :651, :256), which a plan edit never wrote.
 *
 * Making the processor read squads from the snapshot instead would look like the
 * smaller fix, and it is not safe:
 *
 *  1. Every imported subscription would lose its squads. `remnawave-importer`
 *     writes the panel's real membership to the COLUMNS and a snapshot holding
 *     only `importedFrom` / `tag` / `trafficLimitStrategy` — no `internalSquads`
 *     key at all. Reading squads from the snapshot would resolve to "absent" and
 *     the next sync of any kind (a renewal, an admin toggle, the 5-minute
 *     recovery sweep re-driving a FAILED row) would push `activeInternalSquads:
 *     []` and strip those customers off every squad on the panel.
 *  2. The columns are legitimately per-subscription state — `EntitlementBoundary`
 *     writes them on a deferred plan activation — so demoting them to a cache of
 *     the snapshot would strand those writes.
 *  3. It would still not PROPAGATE anything. It changes where the value is read
 *     from on the next unrelated push; an operator who edits squads today would
 *     still see nothing happen until each customer happens to sync.
 *
 * So this service does what every other plan→panel path in the codebase already
 * does (`BulkPlanAssignmentService`, `AdminUserSubscriptionsController`): write
 * the subscription's columns, then queue a `ProfileSyncJob(UPDATE)`.
 *
 * ── What it will not touch ────────────────────────────────────────────────
 *
 * Only subscriptions whose columns still hold the plan's PREVIOUS squads are
 * moved. A subscription that was deliberately put on a different squad set
 * (add-on grant, manual panel fix, an import that read live panel membership)
 * has diverged on purpose and is left alone. That also makes the operation
 * idempotent: replaying the same edit propagates nothing the second time.
 */
@Injectable()
export class PlanSquadPropagationService {
  private readonly logger = new Logger(PlanSquadPropagationService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
  ) {}

  /**
   * Runs inside the plan-update transaction so the propagation either lands
   * with the plan write or not at all. Returns the job ids for the caller to
   * enqueue AFTER the transaction commits — a Redis write must never sit
   * inside a database transaction, and a worker must never see a job id whose
   * row is not committed yet.
   */
  public async propagateInTransaction(
    transactionClient: Prisma.TransactionClient,
    input: {
      readonly planId: string;
      readonly previousInternalSquads: readonly string[];
      readonly previousExternalSquad: string | null;
      readonly nextInternalSquads: readonly string[];
      readonly nextExternalSquad: string | null;
      /**
       * Subscribers whose RESET RULE the same save changed (review R4-02).
       * Their columns and snapshot move here like everyone's, and they get no
       * push of their own: the reset rule's push reads the row whole and carries
       * the new squads with the new rule — the follow's, after their terms and
       * add-ons moved (in the term model), or the one written with the edit
       * (outside it). A squad push of their own went out first and handed
       * Remnawave the new rule before the follow had moved their add-ons.
       */
      readonly pushedWithResetRule?: readonly string[];
      readonly now?: Date;
    },
  ): Promise<{
    readonly summary: PlanSquadPropagationSummary;
    readonly syncJobIds: readonly string[];
  }> {
    const previous = {
      internalSquads: input.previousInternalSquads,
      externalSquad: input.previousExternalSquad,
    };
    const next = {
      internalSquads: input.nextInternalSquads,
      externalSquad: input.nextExternalSquad,
    };
    // The overwhelmingly common plan edit — a price, a name, an archive toggle —
    // leaves squads alone. Cost it nothing: no query, no rows, no queue traffic.
    if (sameSquadSelection(previous, next)) {
      return { summary: EMPTY_SUMMARY, syncJobIds: [] };
    }

    // ONE STATEMENT, WHATEVER THE PLAN'S SIZE: the columns AND the snapshot's
    // squads of every tracking subscriber, under each row's lock.
    //
    // Why the snapshot moves with the columns: `resolveInheritedPlanLimitUpdate`
    // (`subscriptions/services/plan-inherited-limits.util.ts`) reads a row as
    // INHERITED when its columns agree with its own snapshot, and a renewal
    // re-applies the plan only to such a row. A plan edit that writes the squad
    // columns IS the plan giving the subscription those squads; left behind, the
    // snapshot's OLD squads made the row read as individually OVERRIDDEN, so no
    // renewal would ever correct its squads again. The two limit keys are not
    // touched: they are the baseline the same reader compares the limit columns
    // against (`PlanSnapshotSyncService`).
    //
    // It used to be one `updateMany` per subscriber inside the plan edit's
    // interactive transaction: measured, some 7,000 subscribers outran its 5 s
    // timeout (P2028) and the whole save rolled back. Here, as in
    // `syncPlanSnapshotMetadata`, the database merges the keys itself
    // (`plan_snapshot || jsonb_build_object(…)`), and the rules the per-row code
    // enforced are the statement's: only rows that still hold the plan's
    // PREVIOUS squads move (`sameSquadSelection`, order-insensitive — the
    // tracking CTE); a DELETED row is never touched; the snapshot's two keys are
    // rewritten unless they already record the new selection (`squadsRecordedSql`).
    // A row deleted between the plan's read and this statement is simply not
    // there to match.
    const now = input.now ?? new Date();
    const previousInternal = [...input.previousInternalSquads];
    const nextInternal = [...input.nextInternalSquads];
    const rows = await transactionClient.$queryRaw<PropagationRow[]>(Prisma.sql`
      WITH "candidates" AS (
        SELECT "id", "status", "remnawave_id", "internal_squads", "external_squad"
          FROM "subscriptions"
         WHERE "plan_snapshot"->>'id' = ${input.planId}
           AND "status" <> 'DELETED'
           FOR UPDATE
      ), "tracking" AS (
        SELECT c."id"
          FROM "candidates" c
         WHERE c."external_squad" IS NOT DISTINCT FROM ${input.previousExternalSquad}::text
           AND ${sameSquadSetSql(Prisma.sql`c."internal_squads"`, previousInternal)}
      ), "moved" AS (
        UPDATE "subscriptions" AS s
           SET "internal_squads" = ${nextInternal}::text[],
               "external_squad" = ${input.nextExternalSquad}::text,
               "plan_snapshot" = ${snapshotSquadsSql(Prisma.sql`s."plan_snapshot"`, nextInternal, input.nextExternalSquad)},
               "updated_at" = ${now}
          FROM "tracking" t
         WHERE s."id" = t."id"
        RETURNING s."id"
      )
      SELECT c."id", c."status"::text AS "status", c."remnawave_id" IS NOT NULL AS "linked",
             EXISTS (SELECT 1 FROM "moved" m WHERE m."id" = c."id") AS "moved"
        FROM "candidates" c
    `);

    const moved = rows.filter((row) => row.moved);
    if (moved.length === 0) {
      // NOT `EMPTY_SUMMARY`. Every subscription on this plan diverged, so none
      // moved — which is a different fact from "the squads did not change", and
      // the two used to be reported identically. This is the case an operator
      // most needs to hear about: they reworked the squads, nothing was
      // propagated, and every one of these customers is still on the old set.
      return {
        summary: { ...EMPTY_SUMMARY, subscriptionsSkippedDiverged: rows.length },
        syncJobIds: [],
      };
    }

    const propagationId = randomUUID();
    // Only a live profile can be pushed to. An EXPIRED / DISABLED subscription
    // still gets its columns corrected above, so whatever syncs it next (a
    // renewal, a re-enable) already carries the new squads.
    //
    // THE TWO REASONS FOR SKIPPING ARE NOT THE SAME REASON, which is why they
    // are counted apart. A non-pushable status is a deferral with a definite
    // end: the row is not live, and the next thing that makes it live syncs it.
    // A missing `remnawaveId` on a LIVE row is not a deferral at all — nothing
    // is scheduled, nothing will notice, and the panel profile keeps serving the
    // squads the plan used to have. Collapsed into one number, that second
    // population was invisible: `syncJobsCreated` simply came out lower than
    // `subscriptionsUpdated` and so did the ordinary case.
    const carriedByResetRule = new Set(input.pushedWithResetRule ?? []);
    const pushable: string[] = [];
    let skippedUnlinked = 0;
    let pushedWithResetRule = 0;
    for (const row of moved) {
      if (!PUSHABLE_STATUSES.has(row.status)) continue;
      if (!row.linked) {
        skippedUnlinked += 1;
        continue;
      }
      if (carriedByResetRule.has(row.id)) {
        pushedWithResetRule += 1;
        continue;
      }
      pushable.push(row.id);
    }
    const syncJobIds = await writeSquadPushesInTransaction(transactionClient, pushable, {
      planId: input.planId,
      propagationId,
      now,
    });

    if (skippedUnlinked > 0) {
      // Inside the transaction on purpose: if the propagation rolls back, this
      // line is a lie about work that never happened — but a Nest logger cannot
      // be rolled back, so it is written where the number is known and kept
      // deliberately factual ("were not pushed"), never a claim about state.
      this.logger.warn(
        `Plan ${input.planId} squad propagation: ${skippedUnlinked} live subscription(s) had ` +
          'their squads rewritten locally but carry no Remnawave id, so nothing was queued for ' +
          'them — their panel profiles still hold the previous squads.',
      );
    }
    return {
      summary: {
        propagationId,
        subscriptionsUpdated: moved.length,
        subscriptionsSkippedDiverged: rows.length - moved.length,
        syncJobsCreated: syncJobIds.length,
        syncJobsSkippedUnlinked: skippedUnlinked,
        pushedWithResetRule,
      },
      syncJobIds,
    };
  }

  /**
   * Nudges BullMQ for the first {@link PLAN_SQUAD_PROPAGATION_ENQUEUE_LIMIT}
   * jobs. Failures are logged and swallowed on purpose: the row is already
   * committed as PENDING, and the recovery sweep re-enqueues PENDING rows — so
   * a Redis hiccup delays the propagation instead of losing it.
   */
  public async enqueueAfterCommit(syncJobIds: readonly string[]): Promise<number> {
    let enqueued = 0;
    for (const syncJobId of syncJobIds.slice(0, PLAN_SQUAD_PROPAGATION_ENQUEUE_LIMIT)) {
      try {
        await this.profileSyncQueueService.enqueue(syncJobId);
        enqueued += 1;
      } catch (error: unknown) {
        this.logger.warn(
          `Plan squad propagation persisted sync job ${syncJobId}; sweep will retry enqueue: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (syncJobIds.length > enqueued) {
      this.logger.log(
        `Plan squad propagation: ${enqueued} job(s) enqueued now, ${
          syncJobIds.length - enqueued
        } left for the profile-sync sweep`,
      );
    }
    return enqueued;
  }

  /**
   * Live progress of a plan's most recent squad propagation, so an operator can
   * answer "is it still going?" without reading the worker log. Scoped to one
   * `propagationId` rather than to the plan, so a second edit reports on the
   * second edit rather than on an ever-growing pile of history.
   *
   * KNOWN COST: `profile_sync_jobs` carries no index on `cause` or on the
   * payload, so both reads below scan. That is deliberate for now — this runs
   * only while an operator is watching a propagation they just started (the UI
   * polls at 3s and stops the moment `isComplete` is true), and adding an index
   * means a schema migration this change does not otherwise need. If plan squad
   * edits become routine on a large `profile_sync_jobs` table, the cheap fix is
   * a partial index on `(cause, created_at DESC) WHERE cause IS NOT NULL`.
   */
  public async getStatus(planId: string): Promise<PlanSquadPropagationStatus> {
    const latest = await this.prismaService.profileSyncJob.findFirst({
      where: {
        cause: PLAN_SQUAD_PROPAGATION_CAUSE,
        payload: { path: ['planId'], equals: planId },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, payload: true },
    });
    const propagationId =
      latest === null ? null : readPropagationId(latest.payload as unknown);
    if (latest === null || propagationId === null) {
      return { ...EMPTY_STATUS, planId };
    }

    const grouped = await this.prismaService.profileSyncJob.groupBy({
      by: ['status'],
      where: {
        cause: PLAN_SQUAD_PROPAGATION_CAUSE,
        payload: { path: ['propagationId'], equals: propagationId },
      },
      _count: { _all: true },
    });

    let pending = 0;
    let running = 0;
    let failed = 0;
    let completed = 0;
    for (const row of grouped) {
      const count = row._count?._all ?? 0;
      if (row.status === SyncJobStatus.PENDING) pending += count;
      else if (row.status === SyncJobStatus.RUNNING) running += count;
      else if (row.status === SyncJobStatus.FAILED) failed += count;
      else if (row.status === SyncJobStatus.COMPLETED) completed += count;
    }

    return {
      planId,
      propagationId,
      queuedAt: latest.createdAt.toISOString(),
      total: pending + running + failed + completed,
      pending,
      running,
      failed,
      completed,
      // FAILED is NOT done: the sweep re-drives transient failures, and a
      // terminal one is a propagation that never landed. Reporting it complete
      // is exactly the silence this whole change exists to remove.
      isComplete: pending === 0 && running === 0 && failed === 0,
    };
  }
}

const EMPTY_SUMMARY: PlanSquadPropagationSummary = {
  propagationId: null,
  subscriptionsUpdated: 0,
  subscriptionsSkippedDiverged: 0,
  syncJobsCreated: 0,
  syncJobsSkippedUnlinked: 0,
  pushedWithResetRule: 0,
};

const EMPTY_STATUS: PlanSquadPropagationStatus = {
  planId: '',
  propagationId: null,
  queuedAt: null,
  total: 0,
  pending: 0,
  running: 0,
  failed: 0,
  completed: 0,
  isComplete: true,
};

/**
 * `sameSquadSet(array, squads)` (`plans/utils/plan-squads.util.ts`) as SQL, for
 * a `text[]` expression: the same length, the same number of distinct entries,
 * and every entry among `squads` — order-insensitive, as the JS rule is.
 */
function sameSquadSetSql(array: Prisma.Sql, squads: readonly string[]): Prisma.Sql {
  return Prisma.sql`(
    cardinality(${array}) = ${squads.length}::int
    AND ${array} <@ ${[...squads]}::text[]
    AND (SELECT count(DISTINCT v) FROM unnest(${array}) AS v) = ${new Set(squads).size}::int
  )`;
}

/**
 * The stored `plan_snapshot` with its two squad keys re-declared as what the
 * PLAN now gives this subscription, every other key left as it is — the merge
 * in the database, so the statement is one whatever the plan's size.
 *
 * The numeric sibling of this is `patchSnapshotNumeric`
 * (`subscriptions/services/plan-inherited-limits.util.ts`); squads need their
 * own because the two keys move together and one of them is an array.
 *
 * Left as it is when it already records exactly this selection
 * (`squadsRecordedSql`), instead of being rewritten to an equal value in
 * another order; a snapshot that is not an object becomes one holding the two
 * keys. Both keys must be PRESENT and well-typed to count as recorded: an
 * absent `externalSquad` reads as UNDECIDABLE at renewal, not as `null`, so
 * taking a missing key for a match would leave the very rows this exists to
 * repair — imported ones, whose snapshot carries no squad keys at all —
 * exactly as unreadable as before.
 */
function snapshotSquadsSql(
  snapshot: Prisma.Sql,
  internalSquads: readonly string[],
  externalSquad: string | null,
): Prisma.Sql {
  const keys = Prisma.sql`jsonb_build_object(
    'internalSquads', to_jsonb(${[...internalSquads]}::text[]),
    'externalSquad', ${externalSquad}::text
  )`;
  // Nested, not one AND: `jsonb_array_elements` raises on a scalar, and only a
  // CASE decides the order its conditions are looked at in.
  return Prisma.sql`(CASE
    WHEN jsonb_typeof(${snapshot}) = 'object' AND jsonb_typeof(${snapshot}->'internalSquads') = 'array'
      THEN (CASE WHEN ${squadsRecordedSql(snapshot, internalSquads, externalSquad)} THEN ${snapshot} ELSE ${snapshot} || ${keys} END)
    WHEN jsonb_typeof(${snapshot}) = 'object' THEN ${snapshot} || ${keys}
    ELSE ${keys}
  END)`;
}

/**
 * Whether an object snapshot whose `internalSquads` is an array already records
 * the selection: `externalSquad` present and equal (JSON `null` for none), and
 * `internalSquads` all strings forming the same set (`sameSquadSet`).
 */
function squadsRecordedSql(
  snapshot: Prisma.Sql,
  internalSquads: readonly string[],
  externalSquad: string | null,
): Prisma.Sql {
  return Prisma.sql`(
    ${snapshot}->'externalSquad' = COALESCE(to_jsonb(${externalSquad}::text), 'null'::jsonb)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(${snapshot}->'internalSquads') AS e(v) WHERE jsonb_typeof(e.v) <> 'string'
    )
    AND jsonb_array_length(${snapshot}->'internalSquads') = ${internalSquads.length}::int
    AND ARRAY(SELECT jsonb_array_elements_text(${snapshot}->'internalSquads')) <@ ${[...internalSquads]}::text[]
    AND (SELECT count(DISTINCT v) FROM jsonb_array_elements_text(${snapshot}->'internalSquads') AS v)
        = ${new Set(internalSquads).size}::int
  )`;
}

/**
 * The squad push of each subscription in `subscriptionIds`, written in the
 * plan edit's transaction in ONE statement: a PENDING `PLAN_SQUAD_UPDATE`
 * UPDATE, or — where one is already waiting — that one, carried over to this
 * propagation (its `planId` and `propagationId`, so the status the operator
 * polls counts it), never a second. The kept row is LOCKED until the commit:
 * a worker claiming it in between would read the subscription as it was
 * before the edit and push the old squads, and the edit would have no push.
 * Returns every push that now carries the edit, for the caller to enqueue once
 * committed. Ids are UUIDs: the table has no database default (Prisma writes a
 * cuid), and the id is only ever read back as a key.
 */
async function writeSquadPushesInTransaction(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  subscriptionIds: readonly string[],
  input: { readonly planId: string; readonly propagationId: string; readonly now: Date },
): Promise<string[]> {
  if (subscriptionIds.length === 0) return [];
  const ids = [...subscriptionIds];
  const rows = await tx.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
    WITH "waiting" AS (
      SELECT j."id", j."subscription_id"
        FROM "profile_sync_jobs" j
       WHERE j."subscription_id" = ANY(${ids}::text[])
         AND j."status" = 'PENDING'
         AND j."superseded_at" IS NULL
         AND j."cause" = ${PLAN_SQUAD_PROPAGATION_CAUSE}
         FOR UPDATE
    ), "kept" AS (
      UPDATE "profile_sync_jobs" AS j
         SET "payload" = (CASE WHEN jsonb_typeof(j."payload") = 'object' THEN j."payload" ELSE '{}'::jsonb END)
                         || jsonb_build_object('planId', ${input.planId}::text, 'propagationId', ${input.propagationId}::text),
             "updated_at" = ${input.now}
        FROM "waiting" w
       WHERE j."id" = w."id"
      RETURNING j."id"
    ), "written" AS (
      INSERT INTO "profile_sync_jobs"
             ("id", "subscription_id", "action", "status", "cause", "payload", "created_at", "updated_at")
      SELECT gen_random_uuid()::text, x."id", 'UPDATE'::"SyncAction", 'PENDING'::"SyncJobStatus",
             ${PLAN_SQUAD_PROPAGATION_CAUSE}::text,
             jsonb_build_object(
               'source', ${PLAN_SQUAD_PROPAGATION_CAUSE}::text,
               'planId', ${input.planId}::text,
               'propagationId', ${input.propagationId}::text
             ),
             ${input.now}, ${input.now}
        FROM unnest(${ids}::text[]) AS x("id")
       WHERE NOT EXISTS (SELECT 1 FROM "waiting" w WHERE w."subscription_id" = x."id")
      RETURNING "id"
    )
    SELECT "id" FROM "written"
    UNION ALL
    SELECT "id" FROM "kept"
  `);
  return rows.map((row) => row.id);
}

function readPropagationId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const candidate = (payload as Record<string, unknown>)['propagationId'];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}
