import { BadRequestException } from '@nestjs/common';
import {
  PlanAvailability,
  PlanMigrationItemOrigin,
  PlanMigrationItemStatus,
  Prisma,
} from '@prisma/client';

import { subscriptionsOnPlanWhere } from '../utils/subscriptions-on-plan.util';
import {
  PLAN_MIGRATION_MAX_EXPLICIT_IDS,
  PLAN_MIGRATION_REASONS,
  PLAN_MIGRATION_REFUSAL_CODES,
  type PlanMigrationReason,
  type PlanMigrationRefusalCode,
} from './plan-migration.codes';
import { PLAN_MIGRATION_READ_CHUNK } from './plan-migration.constants';

/** The operator's request, as both the preview and the run creation receive it. */
export interface PlanMigrationAssignmentInput {
  readonly groups?: ReadonlyArray<{
    readonly targetPlanId: string;
    readonly subscriptionIds: readonly string[];
  }>;
  readonly restTargetPlanId?: string | null;
}

/** One subscription the request resolves to, and what happens to it. */
export interface ResolvedMigrationEntry {
  readonly subscriptionId: string;
  readonly toPlanId: string;
  readonly origin: PlanMigrationItemOrigin;
  /**
   * An outcome decided before any move runs: an explicit id that is not on the
   * source plan (SKIPPED), or twins on one panel profile sent to different
   * targets (FAILED). `null` means the subscription is to be moved (PENDING).
   */
  readonly decided: {
    readonly status: typeof PlanMigrationItemStatus.SKIPPED | typeof PlanMigrationItemStatus.FAILED;
    readonly reason: PlanMigrationReason;
  } | null;
  /**
   * The Remnawave profile this subscription shares with at least one other
   * subscription of the request on the source plan, or `null`. Twins move
   * together or not at all (`PlanMigrationMoveService`), so a row's outcome can
   * depend on its twins' — the preview reads this to say so.
   */
  readonly twinGroup: string | null;
}

export function migrationRefusal(code: PlanMigrationRefusalCode, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}

interface ValidatedAssignment {
  /** Explicit subscription id → its group's target. */
  readonly explicit: ReadonlyMap<string, string>;
  readonly restTargetPlanId: string | null;
}

/**
 * The request-level refusals, in a fixed order: the shape of the request first
 * (nothing asked, too much asked, the same id twice), then its targets (the
 * plan itself, a plan that is gone, a trial plan). Every one is a 400 whose
 * `code` the SPA branches on.
 */
export async function validateMigrationAssignment(
  client: Pick<Prisma.TransactionClient, 'plan'>,
  sourcePlanId: string,
  input: PlanMigrationAssignmentInput,
): Promise<ValidatedAssignment> {
  const groups = input.groups ?? [];
  const restTargetPlanId =
    input.restTargetPlanId === undefined || input.restTargetPlanId === null ? null : input.restTargetPlanId;

  const idCount = groups.reduce((sum, group) => sum + group.subscriptionIds.length, 0);
  if (idCount === 0 && restTargetPlanId === null) {
    throw migrationRefusal(
      PLAN_MIGRATION_REFUSAL_CODES.EMPTY_ASSIGNMENT,
      'Assign at least one subscription to a target plan, or a target for the rest.',
    );
  }
  if (idCount > PLAN_MIGRATION_MAX_EXPLICIT_IDS) {
    throw migrationRefusal(
      PLAN_MIGRATION_REFUSAL_CODES.TOO_MANY_IDS,
      `At most ${PLAN_MIGRATION_MAX_EXPLICIT_IDS} subscription ids may be listed; assign the rest with restTargetPlanId.`,
    );
  }

  const explicit = new Map<string, string>();
  for (const group of groups) {
    for (const subscriptionId of group.subscriptionIds) {
      if (explicit.has(subscriptionId)) {
        throw migrationRefusal(
          PLAN_MIGRATION_REFUSAL_CODES.DUPLICATE_SUBSCRIPTION,
          'A subscription may be assigned to one target plan only.',
        );
      }
      explicit.set(subscriptionId, group.targetPlanId);
    }
  }

  const targets = [
    ...new Set([...groups.map((group) => group.targetPlanId), ...(restTargetPlanId === null ? [] : [restTargetPlanId])]),
  ];
  if (targets.includes(sourcePlanId)) {
    throw migrationRefusal(
      PLAN_MIGRATION_REFUSAL_CODES.TARGET_IS_SOURCE,
      'A subscription cannot be moved to the plan it is being moved off.',
    );
  }
  const rows = await client.plan.findMany({
    where: { id: { in: targets } },
    select: { id: true, deletedAt: true, availability: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const targetPlanId of targets) {
    const row = byId.get(targetPlanId);
    if (row === undefined || row.deletedAt !== null) {
      throw migrationRefusal(PLAN_MIGRATION_REFUSAL_CODES.TARGET_NOT_FOUND, 'Target plan not found.');
    }
  }
  for (const targetPlanId of targets) {
    if (byId.get(targetPlanId)?.availability === PlanAvailability.TRIAL) {
      throw migrationRefusal(
        PLAN_MIGRATION_REFUSAL_CODES.TARGET_IS_TRIAL,
        'A trial plan cannot be a migration target.',
      );
    }
  }

  return { explicit, restTargetPlanId };
}

/**
 * Every subscription a validated request covers, sorted by id.
 *
 * ── The "rest" ───────────────────────────────────────────────────────────────
 *
 * `restTargetPlanId` is resolved HERE, at the moment of the request, against the
 * subscriptions on the plan right now (`subscriptionsOnPlanWhere`, the reference
 * guard's own predicate). A subscription that lands on the plan afterwards is
 * not in the run; the dialog re-reads the list before it deletes.
 *
 * ── Twins on one panel profile (spec §5.3) ───────────────────────────────────
 *
 * `remnawaveId` is not unique: importers left pairs of live rows pointing at one
 * Remnawave profile. A move pushes a row's limits and squads to that profile, so
 * twins on the source plan sent to two different plans would take turns
 * overwriting the one profile. So, per profile among the subscriptions on the
 * source plan:
 *
 *   - the covered twins name more than one target → EVERY covered twin is FAILED
 *     `SHARED_PROFILE_TARGET_CONFLICT`, and nothing about that profile moves;
 *   - they name one target and some twin is not covered → that twin is ADDED to
 *     the run with the same target, `origin = SHARED_PROFILE`, so the profile
 *     ends on one plan. (When the twins conflict, an uncovered twin is not
 *     added: there is no single target to give it.)
 *   - whether they then all CAN move is decided by the move, under their locks,
 *     for the whole group at once — see `PlanMigrationMoveService`.
 *
 * Explicit ids that are not on the plan are kept as SKIPPED `NOT_ON_SOURCE_PLAN`
 * rather than refused, so a stale selection is reported per row.
 */
export async function resolveMigrationEntries(
  client: Pick<Prisma.TransactionClient, 'subscription'>,
  sourcePlanId: string,
  assignment: ValidatedAssignment,
): Promise<ResolvedMigrationEntry[]> {
  const explicitIds = [...assignment.explicit.keys()];
  const onPlan = subscriptionsOnPlanWhere(sourcePlanId);

  const covered = new Map<string, { toPlanId: string; origin: PlanMigrationItemOrigin; remnawaveId: string | null }>();
  for (let offset = 0; offset < explicitIds.length; offset += PLAN_MIGRATION_READ_CHUNK) {
    const chunk = explicitIds.slice(offset, offset + PLAN_MIGRATION_READ_CHUNK);
    const rows = await client.subscription.findMany({
      where: { AND: [{ id: { in: chunk } }, onPlan] },
      select: { id: true, remnawaveId: true },
    });
    for (const row of rows) {
      covered.set(row.id, {
        toPlanId: assignment.explicit.get(row.id) as string,
        origin: PlanMigrationItemOrigin.GROUP,
        remnawaveId: row.remnawaveId,
      });
    }
  }

  if (assignment.restTargetPlanId !== null) {
    const rest = await client.subscription.findMany({
      where: { AND: [onPlan, ...(explicitIds.length === 0 ? [] : [{ id: { notIn: explicitIds } }])] },
      select: { id: true, remnawaveId: true },
    });
    for (const row of rest) {
      if (covered.has(row.id)) continue;
      covered.set(row.id, {
        toPlanId: assignment.restTargetPlanId,
        origin: PlanMigrationItemOrigin.REST,
        remnawaveId: row.remnawaveId,
      });
    }
  }

  // Twins: the profiles more than one subscription on the source plan carries —
  // one grouped read over the plan, however many subscriptions it has — and
  // then only those profiles' subscriptions.
  const twinsByProfile = await readTwinsOnPlan(client, onPlan);

  const conflicted = new Set<string>();
  const added = new Map<string, string>();
  const twinGroupOf = new Map<string, string>();
  for (const [profile, members] of twinsByProfile) {
    const coveredMembers = members.filter((id) => covered.has(id));
    if (coveredMembers.length === 0) continue;
    const targets = new Set(coveredMembers.map((id) => covered.get(id)?.toPlanId));
    if (targets.size > 1) {
      for (const id of coveredMembers) {
        conflicted.add(id);
        twinGroupOf.set(id, profile);
      }
      continue;
    }
    const [target] = [...targets];
    if (target === undefined) continue;
    for (const id of members) {
      twinGroupOf.set(id, profile);
      if (!covered.has(id)) added.set(id, target);
    }
  }

  const entries: ResolvedMigrationEntry[] = [];
  for (const [subscriptionId, entry] of covered) {
    entries.push({
      subscriptionId,
      toPlanId: entry.toPlanId,
      origin: entry.origin,
      decided: conflicted.has(subscriptionId)
        ? { status: PlanMigrationItemStatus.FAILED, reason: PLAN_MIGRATION_REASONS.SHARED_PROFILE_TARGET_CONFLICT }
        : null,
      twinGroup: twinGroupOf.get(subscriptionId) ?? null,
    });
  }
  for (const [subscriptionId, toPlanId] of added) {
    entries.push({
      subscriptionId,
      toPlanId,
      origin: PlanMigrationItemOrigin.SHARED_PROFILE,
      decided: null,
      twinGroup: twinGroupOf.get(subscriptionId) ?? null,
    });
  }
  for (const [subscriptionId, toPlanId] of assignment.explicit) {
    if (covered.has(subscriptionId)) continue;
    entries.push({
      subscriptionId,
      toPlanId,
      origin: PlanMigrationItemOrigin.GROUP,
      decided: { status: PlanMigrationItemStatus.SKIPPED, reason: PLAN_MIGRATION_REASONS.NOT_ON_SOURCE_PLAN },
      twinGroup: null,
    });
  }
  entries.sort((left, right) => (left.subscriptionId < right.subscriptionId ? -1 : left.subscriptionId > right.subscriptionId ? 1 : 0));
  return entries;
}

/**
 * Remnawave profile → the ids of the subscriptions on the plan that carry it,
 * for every profile carried by more than one of them.
 */
async function readTwinsOnPlan(
  client: Pick<Prisma.TransactionClient, 'subscription'>,
  onPlan: Prisma.SubscriptionWhereInput,
): Promise<Map<string, string[]>> {
  const shared = await client.subscription.groupBy({
    by: ['remnawaveId'],
    where: { AND: [onPlan, { remnawaveId: { not: null } }] },
    _count: { _all: true },
    having: { remnawaveId: { _count: { gt: 1 } } },
  });
  const profiles = shared
    .map((row) => row.remnawaveId)
    .filter((profile): profile is string => profile !== null);
  const twins = new Map<string, string[]>();
  for (let offset = 0; offset < profiles.length; offset += PLAN_MIGRATION_READ_CHUNK) {
    const rows = await client.subscription.findMany({
      where: { AND: [onPlan, { remnawaveId: { in: profiles.slice(offset, offset + PLAN_MIGRATION_READ_CHUNK) } }] },
      select: { id: true, remnawaveId: true },
      orderBy: { id: 'asc' },
    });
    for (const row of rows) {
      if (row.remnawaveId === null) continue;
      const list = twins.get(row.remnawaveId) ?? [];
      list.push(row.id);
      twins.set(row.remnawaveId, list);
    }
  }
  return twins;
}
