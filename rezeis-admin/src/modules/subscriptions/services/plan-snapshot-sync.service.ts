import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

import { TrafficLimitStrategyValue } from '../../plans/dto/traffic-limit-strategy.dto';

interface SnapshotSyncPlanInput {
  readonly id: string;
  readonly name: string;
  readonly tag: string | null;
  readonly type: string;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: TrafficLimitStrategyValue;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
}

type SubscriptionSnapshotRow = {
  readonly id: string;
  readonly planSnapshot: Prisma.JsonValue;
};

@Injectable()
export class PlanSnapshotSyncService {
  /**
   * Mirrors the edited plan's fields into every subscriber's `plan_snapshot`.
   *
   * ── `trafficLimit` / `deviceLimit` do NOT reach the panel from here ───────
   *
   * DECISION (deliberate, do not "fix" by adding a fan-out here): a plan's
   * traffic and device limits are written into the snapshot JSON below, and
   * that is as far as an operator's edit travels. Existing subscribers keep
   * their current panel limits until their next renewal or upgrade.
   *
   * The snapshot is not what anything pushes. Every path to Remnawave reads a
   * different place, and a plan edit writes none of them:
   *
   *  - legacy `ProfileSyncProcessor` reads the subscription's own COLUMNS
   *    (`profile-sync.processor.ts` :511-512 on CREATE, :648-649 on UPDATE);
   *  - the versioned/strict path reads `SubscriptionEffectiveProjection`, whose
   *    base is `subscription_terms.base_traffic_limit_bytes` / `base_device_limit`
   *    — frozen when the term was created and never mutated afterwards;
   *  - the entitlement boundary sweep is event-driven (due add-on expiry, due
   *    SCHEDULED term). It never scans the plan table, and a subscriber with no
   *    add-ons is never even visited.
   *
   * So the deferral is real, and so is the "until renewal": renewal re-reads the
   * live plan row — onto the columns on the legacy branch
   * (`payment-subscription-mutation.service.ts` :264-265, :836-841), or into a
   * fresh term's baseline under the entitlement model (:965-967) — and upgrade
   * re-copies them unconditionally (:998-1002).
   *
   * ── Why this is the rule, and not an oversight ────────────────────────────
   *
   * Squads propagate (`PlanSquadPropagationService`) because a squad is the
   * ROUTE, not the goods: leaving a customer on a squad the operator just
   * retired is a broken service. A traffic or device limit is the priced good
   * itself. Propagating a cut would take back something a customer already paid
   * for as a side effect of an admin edit — which is exactly what
   * `BulkPlanAssignmentService` refuses to do by default, for the narrower
   * version of this same act (see its `applyImmediately`, defaulting false).
   *
   * The rule is symmetric: a RAISE waits too. Not because a raise harms anyone,
   * but because a raise that lands instantly cannot be taken back — the only
   * tool that would undo a mistyped `500` is the unconditional shrink this
   * codebase refuses to build. Deferral is the only rule under which a limit
   * typo is still recoverable, and "limit changes apply on renewal" is a rule an
   * operator can hold in their head; "raises now, cuts later" is not.
   *
   * ── If this is ever revisited ─────────────────────────────────────────────
   *
   * An opt-in propagation cannot follow the squad-propagation shape, because
   * limits have two owners and squads have one. It would have to write the
   * subscription columns AND the ACTIVE term's baseline AND rerun
   * `EffectiveProjectionService.recomputeInTransaction` to advance
   * `desiredRevision`. Miss any one and you reproduce, at fan-out scale, the
   * split-brain `upgradeSubscriptionFromPayment` already has: it moves the
   * columns and leaves the term stale, so with `projectionSync` on the next
   * versioned job pushes the OLD baseline back. Build it after the entitlement
   * cutover picks a single owner, not before.
   */
  public async syncPlanSnapshotMetadata(
    prismaClient: Prisma.TransactionClient | PrismaClient,
    plan: SnapshotSyncPlanInput,
  ): Promise<number> {
    const subscriptions = await prismaClient.$queryRaw<readonly SubscriptionSnapshotRow[]>(
      Prisma.sql`
        SELECT "id", "plan_snapshot" AS "planSnapshot"
        FROM "subscriptions"
        WHERE "plan_snapshot"->>'id' = ${plan.id}
      `,
    );

    let updatedCount = 0;
    for (const subscription of subscriptions) {
      const planSnapshot =
        isJsonObject(subscription.planSnapshot) ? { ...subscription.planSnapshot } : {};
      // NOTE: `icon` is deliberately NOT re-synced here. Every other mirrored
      // field tracks the live plan IN THIS JSON, but the icon is frozen at
      // purchase time — a customer's card must not change its glyph because the
      // operator restyled the plan. Do not add `planSnapshot.icon = plan.icon`
      // "for consistency".
      //
      // "Tracks the live plan" means the snapshot, and only the snapshot. The
      // limits written below do not reach the panel from here, by design — see
      // the method doc above before concluding that is a bug.
      planSnapshot.name = plan.name;
      planSnapshot.tag = plan.tag;
      planSnapshot.type = plan.type;
      planSnapshot.trafficLimit = plan.trafficLimit;
      planSnapshot.deviceLimit = plan.deviceLimit;
      planSnapshot.trafficLimitStrategy = plan.trafficLimitStrategy;
      planSnapshot.internalSquads = [...plan.internalSquads];
      planSnapshot.externalSquad = plan.externalSquad;
      await prismaClient.subscription.update({
        where: {
          id: subscription.id,
        },
        data: {
          planSnapshot,
        },
      });
      updatedCount += 1;
    }
    return updatedCount;
  }
}

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
