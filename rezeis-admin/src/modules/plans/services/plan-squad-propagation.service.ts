import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { sameSquadSelection, sameSquadSet } from '../utils/plan-squads.util';

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

/** `createMany` chunk size — keeps bind-parameter counts sane. */
const PROPAGATION_CHUNK_SIZE = 500;

/** Statuses whose panel profile is live enough to be worth pushing to now. */
const PUSHABLE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.LIMITED,
]);

export interface PlanSquadPropagationSummary {
  /** `null` when the write did not change the plan's squads (nothing queued). */
  readonly propagationId: string | null;
  readonly subscriptionsUpdated: number;
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

interface PropagationCandidate {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly remnawaveId: string | null;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
  /**
   * Read so the propagation can re-declare the squads it is about to write as
   * plan-given; see {@link patchSnapshotSquads}.
   */
  readonly planSnapshot: Prisma.JsonValue;
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
   * with the plan write or not at all. Returns the created job ids for the
   * caller to enqueue AFTER the transaction commits — a Redis write must never
   * sit inside a database transaction, and a worker must never see a job id
   * whose row is not committed yet.
   */
  public async propagateInTransaction(
    transactionClient: Prisma.TransactionClient,
    input: {
      readonly planId: string;
      readonly previousInternalSquads: readonly string[];
      readonly previousExternalSquad: string | null;
      readonly nextInternalSquads: readonly string[];
      readonly nextExternalSquad: string | null;
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

    const candidates = (await transactionClient.subscription.findMany({
      where: {
        planSnapshot: { path: ['id'], equals: input.planId },
        status: { not: SubscriptionStatus.DELETED },
      },
      select: {
        id: true,
        status: true,
        remnawaveId: true,
        internalSquads: true,
        externalSquad: true,
        planSnapshot: true,
      },
    })) as readonly PropagationCandidate[];

    const tracking = candidates.filter(
      (candidate) =>
        candidate.externalSquad === input.previousExternalSquad &&
        sameSquadSet(candidate.internalSquads, input.previousInternalSquads),
    );
    if (tracking.length === 0) {
      return { summary: EMPTY_SUMMARY, syncJobIds: [] };
    }

    const propagationId = randomUUID();
    // ROW BY ROW, AND THE SNAPSHOT IN THE SAME WRITE.
    //
    // The columns used to move in chunked `updateMany` calls with the snapshot
    // left behind. That was survivable only while `PlanSnapshotSyncService`
    // mirrored the plan's squads into every subscriber's `plan_snapshot`: the
    // two ended up agreeing anyway, so `resolveInheritedPlanLimitUpdate`
    // (`subscriptions/services/plan-inherited-limits.util.ts`) still read the
    // row as INHERITED and a renewal would re-apply the plan's squads. That
    // mirroring is gone — deliberately, because it destroyed the override
    // baseline for the two LIMIT columns — and with it went the safety net:
    // a propagated row whose snapshot still named the OLD squads read as
    // individually OVERRIDDEN, so no renewal would ever correct its squads
    // again, for the rest of its life.
    //
    // A plan edit that writes a subscription's squad columns IS the plan
    // giving that subscription those squads, so the snapshot must say so. It
    // is per-row because `plan_snapshot` is JSON and every row's is different:
    // a merge cannot be expressed as one `updateMany` payload. The cost is not
    // new — `syncPlanSnapshotMetadata` already walks the SAME population one
    // row at a time earlier in this very transaction — and the alternative
    // (moving the columns in one statement and the snapshots in another) is
    // strictly more work for the same result.
    //
    // `updateMany` on a single id rather than `update`: a subscription deleted
    // between the scan above and this write makes `update` throw P2025 and
    // roll the operator's whole plan edit back. `updateMany` matches zero rows
    // and moves on, which is the correct handling of a row that no longer
    // exists.
    for (const candidate of tracking) {
      const planSnapshot = patchSnapshotSquads(
        candidate.planSnapshot,
        input.nextInternalSquads,
        input.nextExternalSquad,
      );
      await transactionClient.subscription.updateMany({
        where: { id: candidate.id },
        data: {
          internalSquads: [...input.nextInternalSquads],
          externalSquad: input.nextExternalSquad,
          ...(planSnapshot === undefined ? {} : { planSnapshot }),
        },
      });
    }

    // Only a live profile can be pushed to. An EXPIRED / DISABLED subscription
    // still gets its columns corrected above, so whatever syncs it next (a
    // renewal, a re-enable) already carries the new squads.
    //
    // THE TWO REASONS FOR SKIPPING ARE NOT THE SAME REASON, which is why they
    // are no longer one `filter`. A non-pushable status is a deferral with a
    // definite end: the row is not live, and the next thing that makes it live
    // syncs it. A missing `remnawaveId` on a LIVE row is not a deferral at all
    // — nothing is scheduled, nothing will notice, and the panel profile keeps
    // serving the squads the plan used to have. Collapsed into one number, that
    // second population was invisible: `syncJobsCreated` simply came out lower
    // than `subscriptionsUpdated` and so did the ordinary case.
    const pushable: PropagationCandidate[] = [];
    let skippedUnlinked = 0;
    for (const candidate of tracking) {
      if (!PUSHABLE_STATUSES.has(candidate.status)) continue;
      if (candidate.remnawaveId === null) {
        skippedUnlinked += 1;
        continue;
      }
      pushable.push(candidate);
    }
    const syncJobIds: string[] = [];
    for (const chunk of chunked(pushable)) {
      const created = await transactionClient.profileSyncJob.createManyAndReturn({
        data: chunk.map((candidate) => ({
          subscriptionId: candidate.id,
          action: SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          cause: PLAN_SQUAD_PROPAGATION_CAUSE,
          payload: {
            source: PLAN_SQUAD_PROPAGATION_CAUSE,
            planId: input.planId,
            propagationId,
          } satisfies Prisma.InputJsonObject,
        })),
        select: { id: true },
      });
      for (const row of created) {
        syncJobIds.push(row.id);
      }
    }

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
        subscriptionsUpdated: tracking.length,
        syncJobsCreated: syncJobIds.length,
        syncJobsSkippedUnlinked: skippedUnlinked,
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
  syncJobsCreated: 0,
  syncJobsSkippedUnlinked: 0,
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
 * Re-declares a stored `plan_snapshot`'s squad keys as what the PLAN now gives
 * this subscription, leaving every other key untouched.
 *
 * The numeric sibling of this is `patchSnapshotNumeric`
 * (`subscriptions/services/plan-inherited-limits.util.ts`); squads need their
 * own because the two keys move together and one of them is an array.
 *
 * Returns `undefined` when the snapshot already records exactly this
 * selection, so the write leaves the JSON alone instead of rewriting it to an
 * equal value. `sameSquadSet` — the same order-insensitive comparison the
 * tracking filter above and the renewal reader use — is what makes "already
 * records this selection" mean the same thing in all three places; comparing
 * positionally here would rewrite the snapshot on a harmless reordering.
 *
 * Both keys must be PRESENT and well-typed to count as already recorded. An
 * absent `externalSquad` reads as UNDECIDABLE at renewal, not as `null`, so
 * treating a missing key as a match would leave the very rows this exists to
 * repair — imported ones, whose snapshot carries no squad keys at all —
 * exactly as unreadable as before.
 */
function patchSnapshotSquads(
  snapshot: Prisma.JsonValue,
  internalSquads: readonly string[],
  externalSquad: string | null,
): Prisma.InputJsonObject | undefined {
  const stored =
    typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot)
      ? (snapshot as Prisma.JsonObject)
      : null;
  if (stored !== null) {
    const storedInternal = stored['internalSquads'];
    const storedExternal = stored['externalSquad'];
    const externalAlreadyRecorded =
      (storedExternal === null || typeof storedExternal === 'string') &&
      storedExternal === externalSquad;
    const internalAlreadyRecorded =
      Array.isArray(storedInternal) &&
      storedInternal.every((entry): entry is string => typeof entry === 'string') &&
      sameSquadSet(storedInternal, internalSquads);
    if (externalAlreadyRecorded && internalAlreadyRecorded) return undefined;
  }
  return {
    ...(stored ?? {}),
    internalSquads: [...internalSquads],
    externalSquad,
  } as Prisma.InputJsonObject;
}

function readPropagationId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const candidate = (payload as Record<string, unknown>)['propagationId'];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function* chunked<T>(values: readonly T[]): Generator<T[]> {
  for (let index = 0; index < values.length; index += PROPAGATION_CHUNK_SIZE) {
    yield values.slice(index, index + PROPAGATION_CHUNK_SIZE);
  }
}
