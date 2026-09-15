import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  PlanMigrationItemStatus,
  PlanMigrationRunStatus,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { subscriptionsOnPlanWhere } from '../utils/subscriptions-on-plan.util';
import {
  PLAN_MIGRATION_REASONS,
  PLAN_MIGRATION_WARNING_CODES,
  type PlanMigrationSkipReason,
  type PlanMigrationWarningCode,
} from './plan-migration.codes';
import {
  PLAN_MIGRATION_PROBLEMS_PAGE_SIZE,
  PLAN_MIGRATION_READ_CHUNK,
} from './plan-migration.constants';
import {
  resolveMigrationEntries,
  validateMigrationAssignment,
  type PlanMigrationAssignmentInput,
  type ResolvedMigrationEntry,
} from './plan-migration-assignment.util';
import {
  computePlanMigration,
  currentLimitValues,
  describeMigrationOwnership,
  type MigrationKeptField,
  type MigrationLimitValues,
  type MigrationOwnershipView,
  type MigrationTargetPlan,
} from './plan-migration-compute.util';
import {
  loadMigrationSubjectFacts,
  MIGRATION_SUBJECT_SELECT,
  MIGRATION_TARGET_SELECT,
  resolveTargetRenewability,
  toMigrationUserView,
  type MigrationSubjectFacts,
  type MigrationSubjectRow,
  type MigrationUserView,
} from './plan-migration-facts.util';
import { syncJobStateSql, type PlanMigrationSyncState } from './plan-migration-sync-state.util';

export const PLAN_MIGRATION_LIST_DEFAULT_LIMIT = 50;
export const PLAN_MIGRATION_PREVIEW_DEFAULT_LIMIT = 50;

/** `GET /admin/plans/:planId/subscriptions` — one row. */
export interface PlanMigrationSubscriptionItem {
  readonly subscriptionId: string;
  readonly user: MigrationUserView | null;
  readonly status: Exclude<SubscriptionStatus, 'DELETED'>;
  readonly isTrial: boolean;
  readonly expiresAt: string | null;
  readonly remnawaveLinked: boolean;
  /**
   * The subscription's own columns, encoded exactly as `GET /admin/subscriptions`
   * returns them: `trafficLimit` whole GiB, `null` = unlimited; `deviceLimit`,
   * `<= 0` = unlimited.
   */
  readonly limits: {
    readonly trafficLimit: number | null;
    readonly deviceLimit: number;
    readonly internalSquads: readonly string[];
    readonly externalSquad: string | null;
  };
  readonly ownership: MigrationOwnershipView;
  readonly flags: {
    /**
     * A renewal payment of this subscription is in flight — priced for this
     * plan, or for its replacement or a plan chosen on it. The name predates
     * that reading and stays for the wire.
     */
    readonly pendingRenewalForPlan: boolean;
    readonly scheduledTermOnPlan: boolean;
    readonly sharedPanelProfile: boolean;
  };
}

export interface PlanMigrationSubscriptionsPage {
  readonly total: number;
  readonly matched: number;
  readonly items: readonly PlanMigrationSubscriptionItem[];
  readonly nextCursor: string | null;
}

export interface PlanMigrationPreviewRow {
  readonly subscriptionId: string;
  /** Same shape as the list's (§4.1); `null` for an id that names no subscription. */
  readonly user: MigrationUserView | null;
  readonly targetPlanId: string;
  readonly before: MigrationLimitValues;
  readonly after: MigrationLimitValues;
  readonly kept: readonly MigrationKeptField[];
  readonly warnings: readonly PlanMigrationWarningCode[];
  readonly willSkip: PlanMigrationSkipReason | null;
  readonly pushesToRemnawave: boolean;
}

export interface PlanMigrationPreviewSummary {
  readonly targetPlanId: string;
  /** Every row assigned to this target, the skipped ones included. */
  readonly count: number;
  /** Of `count`, the rows that will not move (`willSkip` set). */
  readonly skipped: number;
  /** Counted over the rows that will move; every code present, zero included. */
  readonly warnings: Record<PlanMigrationWarningCode, number>;
}

export interface PlanMigrationPreview {
  /** On the first page (no `cursor`) only; `null` on every later page (spec §9 A3). */
  readonly summary: readonly PlanMigrationPreviewSummary[] | null;
  readonly rows: readonly PlanMigrationPreviewRow[];
  readonly nextCursor: string | null;
}

export type PlanMigrationProblemKind = 'MOVE_FAILED' | 'MOVE_SKIPPED' | 'SYNC_FAILED';

export interface PlanMigrationProblem {
  readonly subscriptionId: string;
  readonly user: MigrationUserView | null;
  readonly targetPlanId: string;
  readonly kind: PlanMigrationProblemKind;
  readonly reason: string;
  readonly detail: string | null;
}

export interface PlanMigrationRunView {
  readonly runId: string;
  readonly status: 'QUEUED' | 'RUNNING' | 'COMPLETED';
  readonly totals: {
    readonly total: number;
    readonly pending: number;
    readonly moved: number;
    readonly skipped: number;
    readonly failed: number;
    /**
     * SKIPPED items per reason, reasons with a count only (spec §9 A2). The
     * dialog's success test reads this, never the first problems page:
     * `NOT_ON_SOURCE_PLAN` and `SUBSCRIPTION_DELETED` leave nothing on the plan.
     */
    readonly skippedByReason: Readonly<Record<string, number>>;
  };
  readonly sync: {
    readonly total: number;
    readonly pending: number;
    readonly completed: number;
    readonly failed: number;
  };
  readonly problems: readonly PlanMigrationProblem[];
  readonly problemsCursor: string | null;
  readonly finished: boolean;
}

interface ListCursor {
  readonly expiresAt: Date | null;
  readonly id: string;
}

/**
 * The delete dialog's reads: who is on the plan, what a move would do to them,
 * and how a run is going. Nothing here writes.
 */
@Injectable()
export class PlanMigrationQueryService {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Subscriptions on the plan (`subscriptionsOnPlanWhere`, the reference guard's
   * own set), newest expiry first — `expiresAt DESC NULLS LAST, id` — paged by
   * an opaque cursor that encodes that position, so a row added or removed
   * between pages neither repeats nor skips its neighbours.
   */
  public async listSubscriptions(
    planId: string,
    query: { readonly search?: string; readonly cursor?: string; readonly limit?: number },
  ): Promise<PlanMigrationSubscriptionsPage> {
    await this.requireLivePlan(planId);
    const limit = query.limit ?? PLAN_MIGRATION_LIST_DEFAULT_LIMIT;
    const onPlan = subscriptionsOnPlanWhere(planId);
    const search = buildSearchWhere(query.search);
    const filtered: Prisma.SubscriptionWhereInput = search === null ? onPlan : { AND: [onPlan, search] };
    const cursor = query.cursor === undefined || query.cursor === '' ? null : decodeListCursor(query.cursor);
    const pageWhere: Prisma.SubscriptionWhereInput =
      cursor === null ? filtered : { AND: [filtered, afterListCursor(cursor)] };

    const [total, matched, rows] = await Promise.all([
      this.prismaService.subscription.count({ where: onPlan }),
      search === null ? Promise.resolve(null) : this.prismaService.subscription.count({ where: filtered }),
      this.prismaService.subscription.findMany({
        where: pageWhere,
        orderBy: [{ expiresAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
        take: limit + 1,
        select: MIGRATION_SUBJECT_SELECT,
      }),
    ]);
    const page = rows.slice(0, limit);
    const facts = await loadMigrationSubjectFacts(this.prismaService, planId, page);

    const items = page.map((row): PlanMigrationSubscriptionItem => {
      const fact = facts.get(row.id) as MigrationSubjectFacts;
      return {
        subscriptionId: row.id,
        user: toMigrationUserView(row.user),
        status: row.status as Exclude<SubscriptionStatus, 'DELETED'>,
        isTrial: row.isTrial,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        remnawaveLinked: row.remnawaveId !== null,
        limits: {
          trafficLimit: row.trafficLimit,
          deviceLimit: row.deviceLimit,
          internalSquads: [...row.internalSquads],
          externalSquad: row.externalSquad,
        },
        ownership: describeMigrationOwnership(row, fact.recorded),
        flags: {
          pendingRenewalForPlan: fact.pendingRenewalForSource,
          scheduledTermOnPlan: fact.scheduledTermBlocks,
          sharedPanelProfile: fact.sharedPanelProfile,
        },
      };
    });
    const last = page[page.length - 1];
    return {
      total,
      matched: matched ?? total,
      items,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeListCursor({ expiresAt: last.expiresAt, id: last.id })
          : null,
    };
  }

  /**
   * The dry run: the SAME resolution and the SAME computation a run performs,
   * without a write. Rows are every subscription the request covers — explicit
   * ids, the rest, pulled-in twins — sorted by id and paged by it.
   *
   * ── What a page costs (spec §9 A3) ───────────────────────────────────────────
   *
   * The first page (no `cursor`) computes every row, because its `summary` counts
   * all of them. A later page answers `summary: null` and computes ONLY its own
   * rows — plus the twins of those rows, whose outcome decides theirs. Resolving
   * which subscriptions the request covers is still done per page (a few id-only
   * reads); reading every snapshot and fact per «load more» made paging a large
   * plan quadratic.
   *
   * ── Twins (the move's rule, shown before it runs) ───────────────────────────
   *
   * A row that could move but shares its Remnawave profile with a twin that
   * cannot (a paid scheduled term) is shown as `SHARED_PROFILE_TWIN_BLOCKED`,
   * which is what the run will record for it.
   */
  public async preview(
    planId: string,
    input: PlanMigrationAssignmentInput & { readonly cursor?: string | null; readonly limit?: number },
  ): Promise<PlanMigrationPreview> {
    await this.requireLivePlan(planId);
    const assignment = await validateMigrationAssignment(this.prismaService, planId, input);
    const entries = await resolveMigrationEntries(this.prismaService, planId, assignment);

    const limit = input.limit ?? PLAN_MIGRATION_PREVIEW_DEFAULT_LIMIT;
    const cursor = input.cursor === undefined || input.cursor === null || input.cursor === '' ? null : input.cursor;
    const firstPage = cursor === null;
    const remaining = firstPage ? entries : entries.filter((entry) => entry.subscriptionId > cursor);
    const pageEntries = remaining.slice(0, limit);
    const pageIds = new Set(pageEntries.map((entry) => entry.subscriptionId));
    const computedEntries = firstPage ? entries : pageEntries;

    const targetIds = orderedTargets(input, computedEntries);
    const targets = new Map(
      (
        await this.prismaService.plan.findMany({
          where: { id: { in: targetIds } },
          select: MIGRATION_TARGET_SELECT,
        })
      ).map((plan) => [plan.id, plan as MigrationTargetPlan]),
    );
    const renewable = await resolveTargetRenewability(this.prismaService, targetIds);
    const blockedTwinGroups = await this.findBlockedTwinGroups(planId, entries, computedEntries);

    const summary = new Map<string, { count: number; skipped: number; warnings: Record<PlanMigrationWarningCode, number> }>();
    for (const targetPlanId of targetIds) {
      summary.set(targetPlanId, { count: 0, skipped: 0, warnings: emptyWarningCounts() });
    }
    const rows: PlanMigrationPreviewRow[] = [];

    for (let offset = 0; offset < computedEntries.length; offset += PLAN_MIGRATION_READ_CHUNK) {
      const chunk = computedEntries.slice(offset, offset + PLAN_MIGRATION_READ_CHUNK);
      const subjects = await this.prismaService.subscription.findMany({
        where: { id: { in: chunk.map((entry) => entry.subscriptionId) } },
        select: MIGRATION_SUBJECT_SELECT,
      });
      const byId = new Map(subjects.map((subject) => [subject.id, subject]));
      const facts = await loadMigrationSubjectFacts(this.prismaService, planId, subjects);

      for (const entry of chunk) {
        const row = buildPreviewRow({
          entry,
          subject: byId.get(entry.subscriptionId) ?? null,
          facts: facts.get(entry.subscriptionId) ?? null,
          target: targets.get(entry.toPlanId) as MigrationTargetPlan,
          targetRenewable: renewable.get(entry.toPlanId) ?? false,
          twinBlocked: entry.twinGroup !== null && blockedTwinGroups.has(entry.twinGroup),
        });
        if (firstPage) {
          const bucket = summary.get(entry.toPlanId);
          if (bucket !== undefined) {
            bucket.count += 1;
            if (row.willSkip !== null) bucket.skipped += 1;
            for (const warning of row.warnings) bucket.warnings[warning] += 1;
          }
        }
        if (pageIds.has(entry.subscriptionId)) rows.push(row);
      }
    }

    const lastRow = rows[rows.length - 1];
    return {
      summary: firstPage ? [...summary].map(([targetPlanId, bucket]) => ({ targetPlanId, ...bucket })) : null,
      rows,
      nextCursor: remaining.length > limit && lastRow !== undefined ? lastRow.subscriptionId : null,
    };
  }

  /**
   * The twin groups among `computed` that cannot move whole: some member on the
   * source plan is held back by a paid scheduled term, so the move will mark
   * every other member `SHARED_PROFILE_TWIN_BLOCKED`. Reads only the members of
   * the groups `computed` touches.
   */
  private async findBlockedTwinGroups(
    planId: string,
    entries: readonly ResolvedMigrationEntry[],
    computed: readonly ResolvedMigrationEntry[],
  ): Promise<Set<string>> {
    const groups = new Set(computed.map((entry) => entry.twinGroup).filter((group): group is string => group !== null));
    const members = entries.filter((entry) => entry.twinGroup !== null && groups.has(entry.twinGroup));
    const blocked = new Set<string>();
    if (members.length === 0) return blocked;
    const subjects = await this.prismaService.subscription.findMany({
      where: { id: { in: members.map((entry) => entry.subscriptionId) } },
      select: { id: true, remnawaveId: true, status: true },
    });
    const live = new Set(
      subjects.filter((subject) => subject.status !== SubscriptionStatus.DELETED).map((subject) => subject.id),
    );
    const facts = await loadMigrationSubjectFacts(this.prismaService, planId, subjects);
    for (const entry of members) {
      if (entry.decided !== null || !live.has(entry.subscriptionId)) continue;
      if (facts.get(entry.subscriptionId)?.scheduledTermBlocks === true) {
        blocked.add(entry.twinGroup as string);
      }
    }
    return blocked;
  }

  /**
   * The plan's open run — QUEUED or RUNNING — so a dialog opened again (a
   * reload, a second tab, the 409 `MIGRATION_ALREADY_RUNNING`) attaches to the
   * run in progress instead of starting another. There is at most one: the
   * partial unique index `plan_migration_runs_open_source_plan_key` allows no
   * second, so `createdAt` only orders the impossible case deterministically.
   *
   * A missing or deleted plan answers `null`, never 404: after a delete the
   * dialog asks this once more and must not have to tell "gone" from "idle".
   * A finished run (COMPLETED) is not current; `GET …/migrations/:runId` still
   * reads it.
   */
  public async getCurrentRun(planId: string): Promise<{ readonly runId: string | null }> {
    const plan = await this.prismaService.plan.findUnique({
      where: { id: planId, deletedAt: null },
      select: { id: true },
    });
    if (plan === null) {
      return { runId: null };
    }
    const run = await this.prismaService.planMigrationRun.findFirst({
      where: {
        sourcePlanId: planId,
        status: { in: [PlanMigrationRunStatus.QUEUED, PlanMigrationRunStatus.RUNNING] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return { runId: run?.id ?? null };
  }

  /**
   * A run's progress for the dialog's poll. Sync counts come from the jobs the
   * items recorded (`plan_migration_items.sync_job_id`) — the same jobs whose
   * payload carries `planMigrationRunId` — never from `cause`, which a newer
   * revision's supersession overwrites. Each job is counted in the state
   * `syncJobStateSql` gives it (spec §9 A1), the definition `SYNC_FAILED`
   * problems and retry `sync` select through as well.
   */
  public async getRun(
    planId: string,
    runId: string,
    problemsCursor?: string,
  ): Promise<PlanMigrationRunView> {
    const run = await this.prismaService.planMigrationRun.findFirst({
      where: { id: runId, sourcePlanId: planId },
      select: { id: true, status: true, totalItems: true },
    });
    if (run === null) {
      throw new NotFoundException('Plan migration run not found');
    }

    const grouped = await this.prismaService.planMigrationItem.groupBy({
      by: ['status', 'reason'],
      where: { runId },
      _count: { _all: true },
    });
    const byStatus = (status: PlanMigrationItemStatus): number =>
      grouped.filter((row) => row.status === status).reduce((sum, row) => sum + row._count._all, 0);
    const skippedByReason: Record<string, number> = {};
    for (const row of grouped) {
      if (row.status !== PlanMigrationItemStatus.SKIPPED) continue;
      const reason = row.reason ?? 'UNKNOWN';
      skippedByReason[reason] = (skippedByReason[reason] ?? 0) + row._count._all;
    }
    const totals = {
      total: grouped.reduce((sum, row) => sum + row._count._all, 0),
      pending: byStatus(PlanMigrationItemStatus.PENDING),
      moved: byStatus(PlanMigrationItemStatus.MOVED),
      skipped: byStatus(PlanMigrationItemStatus.SKIPPED),
      failed: byStatus(PlanMigrationItemStatus.FAILED),
      skippedByReason,
    };

    const syncRows = await this.prismaService.$queryRaw<
      Array<{ readonly state: PlanMigrationSyncState; readonly count: number }>
    >(Prisma.sql`
      SELECT ${syncJobStateSql('j')} AS "state", count(*)::int AS "count"
        FROM "plan_migration_items" AS i
        JOIN "profile_sync_jobs" AS j ON j."id" = i."sync_job_id"
       WHERE i."run_id" = ${runId}
       GROUP BY 1
    `);
    const syncCount = (state: PlanMigrationSyncState): number =>
      syncRows.find((row) => row.state === state)?.count ?? 0;
    const sync = {
      total: syncRows.reduce((sum, row) => sum + row.count, 0),
      pending: syncCount('PENDING'),
      completed: syncCount('COMPLETED'),
      failed: syncCount('FAILED'),
    };

    const problemRows = await this.prismaService.$queryRaw<
      Array<{
        readonly id: string;
        readonly subscriptionId: string;
        readonly toPlanId: string;
        readonly status: PlanMigrationItemStatus;
        readonly reason: string | null;
        readonly detail: string | null;
        readonly lastError: string | null;
      }>
    >(Prisma.sql`
      SELECT i."id", i."subscription_id" AS "subscriptionId", i."to_plan_id" AS "toPlanId",
             i."status"::text AS "status", i."reason", i."detail",
             j."last_error" AS "lastError"
        FROM "plan_migration_items" AS i
        LEFT JOIN "profile_sync_jobs" AS j ON j."id" = i."sync_job_id"
       WHERE i."run_id" = ${runId}
         AND i."id" > ${problemsCursor ?? ''}
         AND (
               i."status" IN ('FAILED', 'SKIPPED')
            OR (i."status" = 'MOVED' AND j."id" IS NOT NULL AND ${syncJobStateSql('j')} = 'FAILED')
         )
       ORDER BY i."id"
       LIMIT ${PLAN_MIGRATION_PROBLEMS_PAGE_SIZE + 1}
    `);
    const pageRows = problemRows.slice(0, PLAN_MIGRATION_PROBLEMS_PAGE_SIZE);
    const users = new Map(
      (
        await this.prismaService.subscription.findMany({
          where: { id: { in: [...new Set(pageRows.map((row) => row.subscriptionId))] } },
          select: { id: true, user: MIGRATION_SUBJECT_SELECT.user },
        })
      ).map((row) => [row.id, toMigrationUserView(row.user)]),
    );
    const problems = pageRows.map((row): PlanMigrationProblem => {
      const user = users.get(row.subscriptionId) ?? null;
      if (row.status === PlanMigrationItemStatus.MOVED) {
        return {
          subscriptionId: row.subscriptionId,
          user,
          targetPlanId: row.toPlanId,
          kind: 'SYNC_FAILED',
          reason: PLAN_MIGRATION_REASONS.SYNC_FAILED,
          detail: redactSyncError(row.lastError),
        };
      }
      return {
        subscriptionId: row.subscriptionId,
        user,
        targetPlanId: row.toPlanId,
        kind: row.status === PlanMigrationItemStatus.FAILED ? 'MOVE_FAILED' : 'MOVE_SKIPPED',
        reason: row.reason ?? PLAN_MIGRATION_REASONS.INTERNAL_ERROR,
        detail: row.detail,
      };
    });
    const lastProblem = pageRows[pageRows.length - 1];

    return {
      runId: run.id,
      status: run.status,
      totals,
      sync,
      problems,
      problemsCursor:
        problemRows.length > PLAN_MIGRATION_PROBLEMS_PAGE_SIZE && lastProblem !== undefined ? lastProblem.id : null,
      finished: run.status === 'COMPLETED' && sync.pending === 0,
    };
  }

  /** 404 for a plan that does not exist or is already deleted. */
  private async requireLivePlan(planId: string): Promise<void> {
    const plan = await this.prismaService.plan.findUnique({
      where: { id: planId, deletedAt: null },
      select: { id: true },
    });
    if (plan === null) {
      throw new NotFoundException('Plan not found');
    }
  }
}

function emptyWarningCounts(): Record<PlanMigrationWarningCode, number> {
  const counts = {} as Record<PlanMigrationWarningCode, number>;
  for (const code of PLAN_MIGRATION_WARNING_CODES) counts[code] = 0;
  return counts;
}

/** Targets in the order the request named them: groups first, then the rest. */
function orderedTargets(
  input: PlanMigrationAssignmentInput,
  entries: readonly ResolvedMigrationEntry[],
): string[] {
  const used = new Set(entries.map((entry) => entry.toPlanId));
  const ordered = [
    ...(input.groups ?? []).map((group) => group.targetPlanId),
    ...(input.restTargetPlanId === undefined || input.restTargetPlanId === null ? [] : [input.restTargetPlanId]),
  ];
  return [...new Set(ordered)].filter((id) => used.has(id));
}

/** What a preview row shows. A row that will not move shows no change. */
export function buildPreviewRow(input: {
  readonly entry: ResolvedMigrationEntry;
  readonly subject: MigrationSubjectRow | null;
  readonly facts: MigrationSubjectFacts | null;
  readonly target: MigrationTargetPlan;
  readonly targetRenewable: boolean;
  /** A twin on this row's Remnawave profile cannot move, so neither will this row. */
  readonly twinBlocked?: boolean;
}): PlanMigrationPreviewRow {
  const { entry, subject, facts } = input;
  const user = toMigrationUserView(subject?.user);
  const unchanged = (willSkip: PlanMigrationSkipReason): PlanMigrationPreviewRow => {
    const values: MigrationLimitValues =
      subject === null
        ? { trafficLimit: null, deviceLimit: 0, internalSquads: [], externalSquad: null, isTrial: false }
        : currentLimitValues(subject);
    return {
      subscriptionId: entry.subscriptionId,
      user,
      targetPlanId: entry.toPlanId,
      before: values,
      after: values,
      kept: [],
      warnings: [],
      willSkip,
      pushesToRemnawave: false,
    };
  };
  if (entry.decided !== null) {
    return unchanged(
      entry.decided.reason === PLAN_MIGRATION_REASONS.SHARED_PROFILE_TARGET_CONFLICT
        ? PLAN_MIGRATION_REASONS.SHARED_PROFILE_TARGET_CONFLICT
        : PLAN_MIGRATION_REASONS.NOT_ON_SOURCE_PLAN,
    );
  }
  if (subject === null || facts === null || subject.status === SubscriptionStatus.DELETED) {
    return unchanged(PLAN_MIGRATION_REASONS.SUBSCRIPTION_DELETED);
  }
  if (facts.scheduledTermBlocks) {
    return unchanged(PLAN_MIGRATION_REASONS.SCHEDULED_TERM);
  }
  if (input.twinBlocked === true) {
    return unchanged(PLAN_MIGRATION_REASONS.SHARED_PROFILE_TWIN_BLOCKED);
  }
  const computed = computePlanMigration({
    subscription: subject,
    target: input.target,
    recorded: facts.recorded,
    targetRenewable: input.targetRenewable,
    pendingRenewalForSource: facts.pendingRenewalForSource,
  });
  return {
    subscriptionId: entry.subscriptionId,
    user,
    targetPlanId: entry.toPlanId,
    before: computed.before,
    after: computed.after,
    kept: computed.kept,
    warnings: computed.warnings,
    willSkip: null,
    pushesToRemnawave: computed.pushesToRemnawave,
  };
}

/**
 * Case-insensitive match on the user's name, username (with or without a
 * leading `@`), e-mail and the subscription id; an all-digit term also matches
 * the Telegram id EXACTLY — the column is a bigint, and a substring of one is
 * not an identifier anybody pastes.
 */
export function buildSearchWhere(search: string | undefined): Prisma.SubscriptionWhereInput | null {
  const term = search?.trim() ?? '';
  if (term.length === 0) return null;
  const insensitive = (value: string) => ({ contains: value, mode: Prisma.QueryMode.insensitive });
  const username = term.startsWith('@') ? term.slice(1) : term;
  const or: Prisma.SubscriptionWhereInput[] = [
    { id: insensitive(term) },
    { user: { name: insensitive(term) } },
    { user: { username: insensitive(username.length > 0 ? username : term) } },
    { user: { email: insensitive(term) } },
  ];
  if (/^\d{1,19}$/.test(term)) {
    const telegramId = BigInt(term);
    if (telegramId <= 9_223_372_036_854_775_807n) or.push({ user: { telegramId } });
  }
  return { OR: or };
}

export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify([cursor.expiresAt?.toISOString() ?? null, cursor.id]), 'utf8').toString('base64url');
}

export function decodeListCursor(raw: string): ListCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === 'string' && parsed[1].length > 0) {
      const [expiresAt, id] = parsed as [unknown, string];
      if (expiresAt === null) return { expiresAt: null, id };
      if (typeof expiresAt === 'string') {
        const date = new Date(expiresAt);
        if (!Number.isNaN(date.getTime())) return { expiresAt: date, id };
      }
    }
  } catch {
    // fall through to the refusal
  }
  throw new BadRequestException('Invalid cursor');
}

/** Rows strictly after the cursor in `expiresAt DESC NULLS LAST, id ASC`. */
export function afterListCursor(cursor: ListCursor): Prisma.SubscriptionWhereInput {
  if (cursor.expiresAt === null) {
    return { expiresAt: null, id: { gt: cursor.id } };
  }
  return {
    OR: [
      { expiresAt: { lt: cursor.expiresAt } },
      { expiresAt: cursor.expiresAt, id: { gt: cursor.id } },
      { expiresAt: null },
    ],
  };
}

/**
 * A profile-sync job's `lastError`, reduced to what an operator may read in the
 * dialog: no URLs, no bearer-looking tokens or `key=value` secrets, one line, at
 * most 300 characters. Squad uuids stay — they are what the operator needs to
 * fix a plan whose squad the panel no longer knows.
 */
export function redactSyncError(lastError: string | null): string | null {
  if (lastError === null) return null;
  const text = lastError
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]')
    .replace(/\b(bearer|token|api[_-]?key|password|secret|authorization)\b(\s*[:=]\s*|\s+)\S+/gi, '$1 [redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return null;
  return text.length <= 300 ? text : `${text.slice(0, 299)}…`;
}
