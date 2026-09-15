import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  PlanMigrationItemStatus,
  PlanMigrationRunStatus,
  Prisma,
  SyncJobStatus,
} from '@prisma/client';
import { Queue } from 'bullmq';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runBullMqEnqueueWithTimeout } from '../../../common/queue/bullmq-enqueue-options';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { PLAN_MIGRATION_REFUSAL_CODES } from './plan-migration.codes';
import {
  PLAN_MIGRATION_BATCH_SIZE,
  PLAN_MIGRATION_CREATE_TIMEOUT_MS,
  PLAN_MIGRATION_IDLE_RETICK_MS,
  PLAN_MIGRATION_QUEUE,
  PLAN_MIGRATION_STALE_RUN_MS,
  PLAN_MIGRATION_TICK_JOB,
} from './plan-migration.constants';
import {
  resolveMigrationEntries,
  validateMigrationAssignment,
  type PlanMigrationAssignmentInput,
} from './plan-migration-assignment.util';
import {
  PlanMigrationMoveService,
  type PlanMigrationRunContext,
} from './plan-migration-move.service';
import { syncJobStateSql } from './plan-migration-sync-state.util';

/** Audit action for the request that started a run — one row per run. */
export const PLAN_MIGRATION_STARTED_AUDIT_ACTION = 'plans.migration.started';

/** Audit action for a retry request — one row per click, with its scope and counts. */
export const PLAN_MIGRATION_RETRIED_AUDIT_ACTION = 'plans.migration.retried';

export interface PlanMigrationTickJobData {
  readonly runId: string;
}

export interface PlanMigrationStartContext {
  readonly currentAdmin: CurrentAdminInterface;
  readonly requestMetadata: RequestMetadataInterface;
}

export type PlanMigrationRetryScope = 'failed' | 'sync';

const ITEM_INSERT_CHUNK = 1000;

const RUN_CONTEXT_SELECT = {
  id: true,
  sourcePlanId: true,
  status: true,
  createdByAdminId: true,
  requestId: true,
  ipAddress: true,
  userAgent: true,
} as const satisfies Prisma.PlanMigrationRunSelect;

/**
 * RUNS A PLAN MIGRATION TO COMPLETION, AND SURVIVES A RESTART DOING IT.
 *
 * The request that starts a run writes the run and ALL its items and answers
 * at once. Everything after that is driven from the database, not from the
 * queue: a tick reads the next PENDING items of its run, moves each in its own
 * transaction (`PlanMigrationMoveService`), and either queues the next tick or
 * marks the run COMPLETED. A BullMQ job is only a nudge.
 *
 *   - Idempotent: only PENDING items are processed, and the move re-checks
 *     PENDING under the item's row lock, so a duplicate tick — the sweep racing
 *     a live one, a job BullMQ retried — moves nothing twice.
 *   - Restart recovery: the sweep re-enqueues every QUEUED/RUNNING run whose row
 *     has not been touched for `PLAN_MIGRATION_STALE_RUN_MS`, and bootstrap does
 *     the same for every open run, so a worker restart or a lost enqueue delays
 *     a run and never strands it.
 *   - Completion is decided under the run's row lock, the same lock "retry
 *     failed" takes before it reopens a run, so a retry landing next to a
 *     finishing tick can never leave a COMPLETED run with PENDING items.
 */
@Injectable()
export class PlanMigrationRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlanMigrationRunnerService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly moveService: PlanMigrationMoveService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    @InjectQueue(PLAN_MIGRATION_QUEUE) private readonly queue: Queue<PlanMigrationTickJobData>,
  ) {}

  /**
   * `POST /admin/plans/:planId/migrations`.
   *
   * Under the plan's row lock (`FOR UPDATE`, the lock the delete takes): a
   * delete of the plan either committed first — 404 — or waits for the run to
   * exist. One QUEUED/RUNNING run per plan: checked here under that lock, and
   * refused by the database's partial unique index if two requests ever got past
   * it (→ the same 409).
   */
  public async startRun(
    planId: string,
    input: PlanMigrationAssignmentInput,
    context: PlanMigrationStartContext,
  ): Promise<{ readonly runId: string; readonly totalItems: number }> {
    let created: { readonly runId: string; readonly totalItems: number; readonly pending: number };
    try {
      created = await this.prismaService.$transaction(
        async (tx) => {
          const [plan] = await tx.$queryRaw<Array<{ readonly id: string; readonly deletedAt: Date | null }>>(
            Prisma.sql`SELECT "id", "deleted_at" AS "deletedAt" FROM "plans" WHERE "id" = ${planId} FOR UPDATE`,
          );
          if (plan === undefined || plan.deletedAt !== null) {
            throw new NotFoundException('Plan not found');
          }
          const open = await tx.planMigrationRun.findFirst({
            where: {
              sourcePlanId: planId,
              status: { in: [PlanMigrationRunStatus.QUEUED, PlanMigrationRunStatus.RUNNING] },
            },
            select: { id: true },
          });
          if (open !== null) {
            throw alreadyRunning();
          }

          const assignment = await validateMigrationAssignment(tx, planId, input);
          const entries = await resolveMigrationEntries(tx, planId, assignment);
          const pending = entries.filter((entry) => entry.decided === null).length;
          const now = new Date();

          const run = await tx.planMigrationRun.create({
            data: {
              sourcePlanId: planId,
              // Nothing to move (every id skipped or conflicted): the run is
              // born finished, and the dialog reads its problems at once.
              status: pending > 0 ? PlanMigrationRunStatus.QUEUED : PlanMigrationRunStatus.COMPLETED,
              ...(pending > 0 ? {} : { startedAt: now, finishedAt: now }),
              createdByAdminId: context.currentAdmin.id,
              requestId: context.requestMetadata.requestId,
              ipAddress: context.requestMetadata.remoteAddress,
              userAgent: context.requestMetadata.userAgent,
              totalItems: entries.length,
            },
            select: { id: true },
          });
          for (let offset = 0; offset < entries.length; offset += ITEM_INSERT_CHUNK) {
            await tx.planMigrationItem.createMany({
              data: entries.slice(offset, offset + ITEM_INSERT_CHUNK).map((entry) => ({
                runId: run.id,
                subscriptionId: entry.subscriptionId,
                fromPlanId: planId,
                toPlanId: entry.toPlanId,
                origin: entry.origin,
                status: entry.decided?.status ?? PlanMigrationItemStatus.PENDING,
                reason: entry.decided?.reason ?? null,
              })),
            });
          }

          const perTarget: Record<string, number> = {};
          for (const entry of entries) perTarget[entry.toPlanId] = (perTarget[entry.toPlanId] ?? 0) + 1;
          await tx.adminAuditLog.create({
            data: {
              action: PLAN_MIGRATION_STARTED_AUDIT_ACTION,
              adminUserId: context.currentAdmin.id,
              ipAddress: context.requestMetadata.remoteAddress,
              userAgent: context.requestMetadata.userAgent,
              metadata: {
                requestId: context.requestMetadata.requestId,
                planId,
                planMigrationRunId: run.id,
                totalItems: entries.length,
                pendingItems: pending,
                restTargetPlanId: assignment.restTargetPlanId,
                itemsPerTarget: perTarget,
              },
            },
          });
          return { runId: run.id, totalItems: entries.length, pending };
        },
        { timeout: PLAN_MIGRATION_CREATE_TIMEOUT_MS, maxWait: PLAN_MIGRATION_CREATE_TIMEOUT_MS },
      );
    } catch (error: unknown) {
      if (isOpenRunUniqueViolation(error)) throw alreadyRunning();
      throw error;
    }

    if (created.pending > 0) {
      await this.enqueueTick(created.runId);
    }
    return { runId: created.runId, totalItems: created.totalItems };
  }

  /**
   * `POST /admin/plans/:planId/migrations/:runId/retry`.
   *
   * `failed`: FAILED items (never SKIPPED — a skip is a fact about the
   * subscription, not an error to try again) go back to PENDING, stamped with
   * the RETRYING admin and request (`actor_*`), so the moves this causes are
   * audited under that admin rather than under the run's creator; a finished run
   * reopens. Reopening is refused with 409 when another run of the plan is open:
   * the partial unique index allows one.
   *
   * `sync`: the run's FAILED profile-sync jobs — FAILED by `syncJobStateSql`, the
   * definition the counts and problems use, so a job BullMQ is about to retry or
   * a superseded one is not re-driven — are re-driven the way the profile-sync
   * sweep re-drives one: reset to PENDING with the attempts cleared, then
   * enqueued with `force` so BullMQ's retained failed job does not swallow the
   * add. Unlike the sweep, the operator's retry does not ask whether the failure
   * was classified TRANSIENT: they asked.
   *
   * Either way one `plans.migration.retried` audit row records who asked, the
   * scope and what it reset.
   */
  public async retry(
    planId: string,
    runId: string,
    scope: PlanMigrationRetryScope,
    context: PlanMigrationStartContext,
  ): Promise<{ readonly runId: string }> {
    const run = await this.prismaService.planMigrationRun.findFirst({
      where: { id: runId, sourcePlanId: planId },
      select: { id: true },
    });
    if (run === null) {
      throw new NotFoundException('Plan migration run not found');
    }
    const audit = (tx: Pick<Prisma.TransactionClient, 'adminAuditLog'>, metadata: Record<string, unknown>) =>
      tx.adminAuditLog.create({
        data: {
          action: PLAN_MIGRATION_RETRIED_AUDIT_ACTION,
          adminUserId: context.currentAdmin.id,
          ipAddress: context.requestMetadata.remoteAddress,
          userAgent: context.requestMetadata.userAgent,
          metadata: {
            requestId: context.requestMetadata.requestId,
            planId,
            planMigrationRunId: runId,
            scope,
            ...metadata,
          } as Prisma.InputJsonObject,
        },
      });

    if (scope === 'failed') {
      let reopened = 0;
      try {
        reopened = await this.prismaService.$transaction(async (tx) => {
          const [locked] = await tx.$queryRaw<Array<{ readonly status: PlanMigrationRunStatus }>>(
            Prisma.sql`SELECT "status"::text AS "status" FROM "plan_migration_runs" WHERE "id" = ${runId} FOR UPDATE`,
          );
          const reset = await tx.planMigrationItem.updateMany({
            where: { runId, status: PlanMigrationItemStatus.FAILED },
            data: {
              status: PlanMigrationItemStatus.PENDING,
              reason: null,
              detail: null,
              actorAdminId: context.currentAdmin.id,
              actorRequestId: context.requestMetadata.requestId,
              actorIpAddress: context.requestMetadata.remoteAddress,
              actorUserAgent: context.requestMetadata.userAgent,
            },
          });
          const reopensRun = reset.count > 0 && locked?.status === PlanMigrationRunStatus.COMPLETED;
          if (reopensRun) {
            await tx.planMigrationRun.update({
              where: { id: runId },
              data: { status: PlanMigrationRunStatus.QUEUED, finishedAt: null },
            });
          }
          await audit(tx, { itemsReset: reset.count, runReopened: reopensRun });
          return reset.count;
        });
      } catch (error: unknown) {
        if (isOpenRunUniqueViolation(error)) throw alreadyRunning();
        throw error;
      }
      if (reopened > 0) {
        await this.enqueueTick(runId);
      }
      return { runId };
    }

    const failedJobs = await this.prismaService.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
      SELECT j."id"
        FROM "plan_migration_items" AS i
        JOIN "profile_sync_jobs" AS j ON j."id" = i."sync_job_id"
       WHERE i."run_id" = ${runId}
         AND ${syncJobStateSql('j')} = 'FAILED'
    `);
    let jobsReset = 0;
    for (const job of failedJobs) {
      const reset = await this.prismaService.profileSyncJob.updateMany({
        where: { id: job.id, status: SyncJobStatus.FAILED, supersededAt: null },
        data: { status: SyncJobStatus.PENDING, attempts: 0, lastError: null },
      });
      if (reset.count !== 1) continue;
      jobsReset += 1;
      try {
        await runBullMqEnqueueWithTimeout(() => this.profileSyncQueueService.enqueue(job.id, true));
      } catch (error: unknown) {
        // The row is PENDING again; the profile-sync sweep enqueues it.
        this.logger.warn(
          `Plan migration ${runId}: sync job ${job.id} reset for retry; the sweep will enqueue it: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await audit(this.prismaService, { syncJobsReset: jobsReset });
    return { runId };
  }

  /** One batch of one run. Called by `PlanMigrationProcessor`. */
  public async processTick(runId: string): Promise<void> {
    const run = await this.prismaService.planMigrationRun.findUnique({
      where: { id: runId },
      select: RUN_CONTEXT_SELECT,
    });
    if (run === null || run.status === PlanMigrationRunStatus.COMPLETED) return;

    const now = new Date();
    await this.prismaService.planMigrationRun.updateMany({
      where: { id: runId, status: PlanMigrationRunStatus.QUEUED },
      data: { status: PlanMigrationRunStatus.RUNNING, startedAt: now },
    });
    // The heartbeat the stale-run sweep reads.
    await this.prismaService.planMigrationRun.updateMany({
      where: { id: runId, status: PlanMigrationRunStatus.RUNNING },
      data: { updatedAt: now },
    });

    const context: PlanMigrationRunContext = run;
    const items = await this.prismaService.planMigrationItem.findMany({
      where: { runId, status: PlanMigrationItemStatus.PENDING },
      orderBy: { id: 'asc' },
      take: PLAN_MIGRATION_BATCH_SIZE,
      select: { id: true },
    });
    let progressed = 0;
    for (const item of items) {
      const outcome = await this.moveService.processItem(context, item.id);
      if (outcome.kind !== 'NOOP') progressed += 1;
    }

    if (await this.completeIfDone(runId)) {
      this.logger.log(`Plan migration ${runId} completed`);
      return;
    }
    await this.enqueueTick(runId, progressed === 0 ? PLAN_MIGRATION_IDLE_RETICK_MS : 0);
  }

  /** Every minute: a QUEUED/RUNNING run nobody has touched lately gets a tick. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'plan-migration-sweep' })
  public async sweepStaleRuns(): Promise<number> {
    if (!shouldRunSchedules()) return 0;
    try {
      const stale = await this.prismaService.planMigrationRun.findMany({
        where: {
          status: { in: [PlanMigrationRunStatus.QUEUED, PlanMigrationRunStatus.RUNNING] },
          updatedAt: { lt: new Date(Date.now() - PLAN_MIGRATION_STALE_RUN_MS) },
        },
        select: { id: true },
        take: 50,
      });
      for (const run of stale) await this.enqueueTick(run.id);
      return stale.length;
    } catch (error: unknown) {
      this.logger.error(
        `Plan migration sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  /** After a restart, every open run gets a tick right away rather than at the next sweep. */
  public async onApplicationBootstrap(): Promise<void> {
    if (!shouldRunSchedules()) return;
    try {
      const open = await this.prismaService.planMigrationRun.findMany({
        where: { status: { in: [PlanMigrationRunStatus.QUEUED, PlanMigrationRunStatus.RUNNING] } },
        select: { id: true },
      });
      for (const run of open) await this.enqueueTick(run.id);
    } catch (error: unknown) {
      // A database not reachable at boot must not stop the application; the
      // sweep resumes the runs once it is.
      this.logger.warn(
        `Plan migration resume at boot skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async completeIfDone(runId: string): Promise<boolean> {
    return this.prismaService.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "plan_migration_runs" WHERE "id" = ${runId} FOR UPDATE`);
      const pending = await tx.planMigrationItem.count({
        where: { runId, status: PlanMigrationItemStatus.PENDING },
      });
      if (pending > 0) return false;
      await tx.planMigrationRun.updateMany({
        where: { id: runId, status: { not: PlanMigrationRunStatus.COMPLETED } },
        data: { status: PlanMigrationRunStatus.COMPLETED, finishedAt: new Date() },
      });
      return true;
    });
  }

  /**
   * No custom job id: a duplicate tick is harmless (see the class note), and
   * the database — not BullMQ's dedupe — is what makes it so. Bounded, and never
   * thrown: the run's rows are committed, and the sweep picks up a run whose
   * tick never reached Redis.
   */
  private async enqueueTick(runId: string, delay = 0): Promise<void> {
    try {
      await runBullMqEnqueueWithTimeout(() =>
        this.queue.add(
          PLAN_MIGRATION_TICK_JOB,
          { runId },
          {
            delay,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        ),
      );
    } catch (error: unknown) {
      this.logger.warn(
        `Plan migration ${runId}: tick not enqueued; the sweep will resume the run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function alreadyRunning(): ConflictException {
  return new ConflictException({
    code: PLAN_MIGRATION_REFUSAL_CODES.MIGRATION_ALREADY_RUNNING,
    message: 'A migration of this plan is already running.',
  });
}

/**
 * The partial unique index `plan_migration_runs_open_source_plan_key` refused an
 * insert or a reopen. Measured on PostgreSQL 17 through Prisma 7's adapter: P2002
 * with `meta.modelName = 'PlanMigrationRun'` and the SQLSTATE 23505 under
 * `meta.driverAdapterError.cause.originalCode`. The run table has no other unique
 * key, so the model name is what separates it from a (never expected) item
 * collision, which stays a 500.
 */
function isOpenRunUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const meta = error.meta as
    | {
        readonly modelName?: unknown;
        readonly driverAdapterError?: { readonly cause?: { readonly code?: unknown; readonly originalCode?: unknown } };
      }
    | undefined;
  const cause = meta?.driverAdapterError?.cause;
  const uniqueViolation = error.code === 'P2002' || cause?.code === '23505' || cause?.originalCode === '23505';
  return uniqueViolation && meta?.modelName === 'PlanMigrationRun';
}
