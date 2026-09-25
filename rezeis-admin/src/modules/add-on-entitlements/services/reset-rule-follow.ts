import { Prisma, SubscriptionStatus, SyncAction, SyncJobStatus, TrafficLimitStrategy } from '@prisma/client';

import { DEFAULT_REMNAWAVE_TIME_ZONE } from '../domain/reset-cycle-policy';
import { readRemnawaveTimeZoneInTransaction } from './reset-epoch.util';
import type { SubscriptionTermService } from './subscription-term.service';

/**
 * A SUBSCRIPTION'S TERMS FOLLOW THE RESET RULE ITS SNAPSHOT NAMES (P6), ONE
 * SUBSCRIPTION PER SHORT TRANSACTION — after the write that changed the rule
 * has committed.
 *
 * WHY NOT INSIDE THE WRITE. A plan edit that changes «Сброс трафика» used to
 * run this for every subscriber inside the edit's own transaction: a row lock,
 * the terms, the re-dating of the «до сброса» add-ons and a push, per
 * subscriber, in ONE interactive transaction with Prisma's 5-second timeout.
 * About 4.7 ms a subscriber on a local database, so a plan that ever had some
 * 1,000 buyers could not have its rule changed at all — the edit rolled back
 * with P2028 (review R3a-01). The edit now commits the plan and the
 * subscribers' snapshots (one statement, `PlanSnapshotSyncService`), and this
 * runs after it, subscriber by subscriber.
 *
 * WHAT ONE STEP DOES, under the subscription's row lock: reads the rule the
 * snapshot names — the one the panel pushes to Remnawave — and has the terms
 * of the snapshot's plan follow it (`SubscriptionTermService.followResetRuleInTransaction`:
 * the terms take the rule, the «до сброса» add-ons end at the first reset
 * under it, never later than promised). The rule is read HERE, not handed in:
 * a second edit that committed meanwhile is followed, not undone.
 *
 * IDEMPOTENT: terms already on the rule change nothing, so a step run twice —
 * the edit's own pass and the sweep racing it, a retry after a crash — does
 * nothing the second time. RESUMABLE: what is left to do is visible in the
 * data itself — a live subscription whose terms of its plan name another rule
 * than its snapshot ({@link selectResetRuleFollowCandidates}) — so the boundary
 * scheduler's sweep finishes whatever a crash, a restart or a failed step left
 * behind. One subscription's failure never stops the others.
 *
 * THE PUSH GOES OUT AT ONCE. Remnawave runs whatever strategy the panel pushed
 * last, and until this rule reaches it the old one keeps resetting. Each step
 * leaves a PENDING push for a live, linked subscription and hands its id back;
 * the runner enqueues it the moment the step has committed — no worker ever
 * sees a job whose row is not committed, and nobody waits for the five-minute
 * sweep. A push already waiting for the same reason is reused, not doubled.
 *
 * …EXCEPT FOR THE ROWS THE SWEEP CANNOT SEE (review R4-01). A subscription with
 * no ACTIVE or SCHEDULED term of its snapshot's plan — outside the term model:
 * created while «Новый учёт докупок» was off, held by a failed cutover, or one
 * the background cutover has not reached — has nothing to follow, so nothing in
 * the data says a push is owed. Left to the runner, a restart before it reached
 * such a row lost its push for good, and Remnawave went on resetting it by the
 * old rule while the panel read the new one. Its push is therefore written BY
 * THE EDIT ITSELF, in the edit's own transaction
 * ({@link writeResetRulePushesInTransaction}): durable from the commit, put on
 * the queue by the edit's caller, and sent by the profile-sync sweep after any
 * crash. Rows in the model keep this order — the terms follow first, then the
 * push — so their add-ons move before Remnawave does.
 */

/** `cause` and `payload.source` of the push a changed reset rule queues for a live subscriber. */
export const PLAN_STRATEGY_UPDATE_CAUSE = 'PLAN_STRATEGY_UPDATE';

const RESET_STRATEGIES: ReadonlySet<string> = new Set(Object.values(TrafficLimitStrategy));

/** A client that can open the short transactions: `PrismaService`. */
export interface ResetRuleFollowClient {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  readonly settings: Prisma.TransactionClient['settings'];
  readonly $queryRaw: Prisma.TransactionClient['$queryRaw'];
}

export interface ResetRuleFollowDeps {
  readonly prisma: ResetRuleFollowClient;
  readonly terms: Pick<SubscriptionTermService, 'followResetRuleInTransaction'>;
  /** Puts a committed PENDING push on the profile-sync queue. A failure leaves the row for the profile-sync sweep. */
  readonly enqueue?: (syncJobId: string) => Promise<void>;
  readonly logger?: { warn(message: string): void };
}

export interface ResetRuleFollowOptions {
  /** Correlates the add-on events a re-dating writes, e.g. `plan-edit:<planId>`. */
  readonly correlationId: string;
  /**
   * `always` — the caller knows the rule changed for these subscriptions (a
   * plan edit), so a live one is pushed even when no term moved. `if-followed`
   * — only a subscription whose terms moved is pushed (the sweep, which finds
   * only rows whose terms disagree). `never` — the caller writes a push of its
   * own in the same transaction, which reads the row whole (an add-on capture:
   * review R4-02).
   */
  readonly push: 'always' | 'if-followed' | 'never';
  /** «Часовой пояс Remnawave»; read once, before the first step, when absent. */
  readonly remnawaveTimeZone?: string;
  /** The instant the new rule's first reset is counted from; each step's own "now" when absent. */
  readonly now?: Date;
  /**
   * Asked before each subscription: `true` stops the run there — a stopping
   * process lets the step in progress finish and leaves the rest to the sweep.
   */
  readonly shouldStop?: () => boolean;
}

export interface ResetRuleFollowSummary {
  /** Subscriptions whose terms took the rule in this run. */
  readonly followed: number;
  /** Steps that failed; the sweep takes them up again. */
  readonly failed: number;
  /** Pushes put on the queue. */
  readonly enqueued: number;
}

type LockedSubscription = {
  readonly status: string;
  readonly strategy: string | null;
  readonly planId: string | null;
  readonly remnawaveId: string | null;
};

/**
 * One step — see the header. Returns what moved and the pushes to enqueue once
 * the caller's transaction has committed.
 */
export async function followSubscriptionResetRuleInTransaction(
  tx: Prisma.TransactionClient,
  terms: Pick<SubscriptionTermService, 'followResetRuleInTransaction'>,
  subscriptionId: string,
  options: Omit<ResetRuleFollowOptions, 'now'> & { readonly now: Date },
): Promise<{ readonly termsUpdated: number; readonly syncJobIds: readonly string[] }> {
  const locked = await tx.$queryRaw<LockedSubscription[]>(Prisma.sql`
    SELECT "status"::text AS "status",
           "plan_snapshot"->>'trafficLimitStrategy' AS "strategy",
           "plan_snapshot"->>'id' AS "planId",
           "remnawave_id" AS "remnawaveId"
      FROM "subscriptions"
     WHERE "id" = ${subscriptionId}
       FOR UPDATE
  `);
  const row = locked[0];
  // Gone, retired, or a snapshot that names no rule of its own (an old
  // import): nothing here to follow.
  if (
    row === undefined ||
    row.status === SubscriptionStatus.DELETED ||
    row.strategy === null ||
    !RESET_STRATEGIES.has(row.strategy)
  ) {
    return { termsUpdated: 0, syncJobIds: [] };
  }

  const followed = await terms.followResetRuleInTransaction(tx, {
    subscriptionId,
    strategy: row.strategy as TrafficLimitStrategy,
    // Only the terms minted from the snapshot's plan: a queued term of
    // another plan (a deferred plan change) keeps its own rule.
    ...(row.planId === null ? {} : { planId: row.planId }),
    remnawaveTimeZone: options.remnawaveTimeZone,
    now: options.now,
    correlationId: options.correlationId,
  });

  if (options.push === 'never') return { termsUpdated: followed.termsUpdated, syncJobIds: [] };
  const live = row.status === SubscriptionStatus.ACTIVE || row.status === SubscriptionStatus.LIMITED;
  const wanted = options.push === 'always' || followed.termsUpdated > 0;
  if (!live || row.remnawaveId === null || !wanted) return { termsUpdated: followed.termsUpdated, syncJobIds: [] };

  const waiting = await tx.profileSyncJob.findMany({
    where: {
      subscriptionId,
      status: SyncJobStatus.PENDING,
      supersededAt: null,
      cause: PLAN_STRATEGY_UPDATE_CAUSE,
    },
    select: { id: true },
  });
  if (waiting.length > 0) return { termsUpdated: followed.termsUpdated, syncJobIds: waiting.map((job) => job.id) };
  const job = await tx.profileSyncJob.create({
    data: {
      subscriptionId,
      action: SyncAction.UPDATE,
      status: SyncJobStatus.PENDING,
      cause: PLAN_STRATEGY_UPDATE_CAUSE,
      payload: {
        source: PLAN_STRATEGY_UPDATE_CAUSE,
        ...(row.planId === null ? {} : { planId: row.planId }),
      } satisfies Prisma.InputJsonObject,
    },
    select: { id: true },
  });
  return { termsUpdated: followed.termsUpdated, syncJobIds: [job.id] };
}

/**
 * The runner — see the header: each subscription in a short transaction of its
 * own, its push enqueued as soon as that transaction has committed. Never
 * throws; a step that fails is counted, logged and left to the sweep.
 */
export async function followResetRules(
  deps: ResetRuleFollowDeps,
  subscriptionIds: readonly string[],
  options: ResetRuleFollowOptions,
): Promise<ResetRuleFollowSummary> {
  if (subscriptionIds.length === 0) return { followed: 0, failed: 0, enqueued: 0 };
  // ONE read of the zone for the whole run, before any transaction opens; the
  // explicit UTC stops each step from reading it again.
  const remnawaveTimeZone =
    options.remnawaveTimeZone ?? (await readRemnawaveTimeZoneInTransaction(deps.prisma)) ?? DEFAULT_REMNAWAVE_TIME_ZONE;
  let followed = 0;
  let failed = 0;
  let enqueued = 0;
  for (const subscriptionId of subscriptionIds) {
    if (options.shouldStop?.() === true) break;
    let step: { readonly termsUpdated: number; readonly syncJobIds: readonly string[] };
    try {
      step = await deps.prisma.$transaction((tx) =>
        followSubscriptionResetRuleInTransaction(tx, deps.terms, subscriptionId, {
          correlationId: options.correlationId,
          push: options.push,
          remnawaveTimeZone,
          now: options.now ?? new Date(),
        }),
      );
    } catch (error: unknown) {
      failed += 1;
      deps.logger?.warn(
        `Reset rule not followed for subscription ${subscriptionId} (${options.correlationId}); the sweep retries it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    if (step.termsUpdated > 0) followed += 1;
    if (deps.enqueue !== undefined) {
      enqueued += await enqueueResetRulePushes(deps.enqueue, step.syncJobIds, { logger: deps.logger });
    }
  }
  return { followed, failed, enqueued };
}

/**
 * The push of a changed reset rule for the subscriptions the sweep cannot see
 * (see the header: no ACTIVE or SCHEDULED term of their snapshot's plan),
 * written in the CALLER's transaction — the one that changes the rule — so it
 * is as durable as the change: one PENDING `PLAN_STRATEGY_UPDATE` UPDATE per
 * subscription, in ONE statement whatever their number.
 *
 * The caller hands only live, linked subscriptions (a push reaches nobody
 * else). One with a push of this cause already PENDING keeps that one — no
 * second push — and that row is LOCKED until the caller commits: a worker that
 * claimed it in between would read the subscription as it was before the
 * change and push the old rule, and the change would then have no push at all.
 * Locked, the claim waits for the commit and the worker reads the new rule.
 *
 * Returns every push that now carries the change, written or kept, for the
 * caller to enqueue once it has committed ({@link enqueueResetRulePushes}).
 * Ids are UUIDs: the table has no database default (Prisma writes a cuid), and
 * the id is only ever read back as a key.
 */
export async function writeResetRulePushesInTransaction(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  subscriptionIds: readonly string[],
  input: { readonly planId: string; readonly now: Date },
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
         AND j."cause" = ${PLAN_STRATEGY_UPDATE_CAUSE}
         FOR UPDATE
    ), "written" AS (
      INSERT INTO "profile_sync_jobs"
             ("id", "subscription_id", "action", "status", "cause", "payload", "created_at", "updated_at")
      SELECT gen_random_uuid()::text, x."id", 'UPDATE'::"SyncAction", 'PENDING'::"SyncJobStatus",
             ${PLAN_STRATEGY_UPDATE_CAUSE}::text,
             jsonb_build_object('source', ${PLAN_STRATEGY_UPDATE_CAUSE}::text, 'planId', ${input.planId}::text),
             ${input.now}, ${input.now}
        FROM unnest(${ids}::text[]) AS x("id")
       WHERE NOT EXISTS (SELECT 1 FROM "waiting" w WHERE w."subscription_id" = x."id")
      RETURNING "id"
    )
    SELECT "id" FROM "written"
    UNION ALL
    SELECT "id" FROM "waiting"
  `);
  return rows.map((row) => row.id);
}

/** Where a walk over the waiting pushes resumes: after this row, in creation order. */
export interface WaitingPushCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * The pushes of a changed reset rule still WAITING — PENDING, not superseded,
 * cause `PLAN_STRATEGY_UPDATE` — in creation order after `after`, at most
 * `limit` (FX5 item 3). What a crash while the edit's caller enqueued them, or
 * a Redis outage, leaves behind: the rows are durable, but only the profile-sync
 * sweep sent them, 100 every five minutes — hours for a plan of 10,000 outside
 * the term model. The reset-rule sweep walks them with this, a batch a run.
 */
export async function selectWaitingResetRulePushes(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  after: WaitingPushCursor | null,
  limit: number,
): Promise<WaitingPushCursor[]> {
  const rows = await client.$queryRaw<Array<{ readonly id: string; readonly createdAt: Date }>>(Prisma.sql`
    SELECT j."id", j."created_at" AS "createdAt"
      FROM "profile_sync_jobs" j
     WHERE j."cause" = ${PLAN_STRATEGY_UPDATE_CAUSE}
       AND j."status" = 'PENDING'
       AND j."superseded_at" IS NULL
       ${after === null ? Prisma.empty : Prisma.sql`AND (j."created_at", j."id") > (${after.createdAt}, ${after.id})`}
     ORDER BY j."created_at" ASC, j."id" ASC
     LIMIT ${limit}
  `);
  return rows.map((row) => ({ id: row.id, createdAt: new Date(row.createdAt) }));
}

/**
 * Puts committed pushes on the profile-sync queue, one by one, stopping when
 * `shouldStop` says so. Never throws: a push that is not enqueued stays
 * PENDING, and the profile-sync sweep sends it. Returns how many were enqueued.
 */
export async function enqueueResetRulePushes(
  enqueue: (syncJobId: string) => Promise<void>,
  syncJobIds: readonly string[],
  options: { readonly logger?: { warn(message: string): void }; readonly shouldStop?: () => boolean } = {},
): Promise<number> {
  let enqueued = 0;
  for (const syncJobId of syncJobIds) {
    if (options.shouldStop?.() === true) break;
    try {
      await enqueue(syncJobId);
      enqueued += 1;
    } catch (error: unknown) {
      options.logger?.warn(
        `Reset rule push ${syncJobId} committed but not enqueued; the profile-sync sweep sends it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return enqueued;
}

/**
 * What is left to follow: live subscriptions (anything but DELETED) with an
 * ACTIVE or SCHEDULED term of their snapshot's plan — or, for a row no plan
 * owns (an import's own, whose re-import may rewrite the donor's rule), with
 * no plan either — whose rule is not the one the snapshot names; in id order
 * after `afterId`, so a row that keeps failing cannot stand in front of the
 * rest.
 */
export async function selectResetRuleFollowCandidates(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  afterId: string,
  limit: number,
): Promise<string[]> {
  const rows = await client.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
    SELECT DISTINCT s."id"
      FROM "subscriptions" s
      JOIN "subscription_terms" t ON t."subscription_id" = s."id"
     WHERE s."status" <> 'DELETED'
       AND s."id" > ${afterId}
       AND t."status" IN ('ACTIVE', 'SCHEDULED')
       AND t."plan_id" IS NOT DISTINCT FROM s."plan_snapshot"->>'id'
       AND s."plan_snapshot"->>'trafficLimitStrategy' = ANY(${[...RESET_STRATEGIES]}::text[])
       AND t."traffic_reset_strategy"::text <> s."plan_snapshot"->>'trafficLimitStrategy'
     ORDER BY s."id" ASC
     LIMIT ${limit}
  `);
  return rows.map((row) => row.id);
}

/**
 * Everything the data says is left to follow — at most `limit` subscriptions
 * — for a writer that has just rewritten snapshots in bulk and wants the terms
 * to follow before anything pushes them: an import, whose re-snapshot may
 * rewrite the reset rule of a row no plan owns (`reimportPlanSnapshot`), or
 * take Remnawave's own for it. What is past `limit`, the boundary scheduler's
 * sweep finishes.
 */
export async function followChangedResetRules(
  deps: ResetRuleFollowDeps,
  options: Omit<ResetRuleFollowOptions, 'now'> & { readonly limit: number },
): Promise<ResetRuleFollowSummary & { readonly examined: number }> {
  const page = 500;
  let cursor = '';
  let examined = 0;
  let followed = 0;
  let failed = 0;
  let enqueued = 0;
  while (examined < options.limit) {
    const batch = await selectResetRuleFollowCandidates(deps.prisma, cursor, Math.min(page, options.limit - examined));
    if (batch.length === 0) break;
    const summary = await followResetRules(deps, batch, options);
    examined += batch.length;
    followed += summary.followed;
    failed += summary.failed;
    enqueued += summary.enqueued;
    cursor = batch[batch.length - 1]!;
  }
  return { examined, followed, failed, enqueued };
}
