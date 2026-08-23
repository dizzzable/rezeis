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
   * Mirrors the edited plan's DISPLAY fields into every subscriber's
   * `plan_snapshot`.
   *
   * ── What this writes, and what it deliberately does not ──────────────────
   *
   * Mirrored: `name`, `tag`, `type`, `trafficLimitStrategy`.
   * Frozen:   `icon`, and `trafficLimit` / `deviceLimit` / `internalSquads` /
   *           `externalSquad`.
   *
   * The four limit keys USED to be mirrored here. They are not any more,
   * because they are the baseline `resolveInheritedPlanLimitUpdate`
   * (`plan-inherited-limits.util.ts`) compares a subscription's columns against
   * to decide whether an operator individually adjusted it. While they tracked
   * the live plan, a single plan edit moved that baseline out from under every
   * subscriber at once: their columns still held the old value, so all of them
   * read as "individually overridden" and their limits were pinned for good.
   * Freezing the four restores the snapshot's actual meaning — what the plan
   * gave THIS subscription when it was assigned.
   *
   * ── Limit edits still reach existing subscribers, at renewal ─────────────
   *
   * Nothing here pushes a limit to Remnawave, and nothing else re-derives one
   * on a plan edit either. Every path to the panel reads somewhere this write
   * does not touch:
   *
   *  - legacy `ProfileSyncProcessor` reads the subscription's own COLUMNS;
   *  - the versioned/strict path reads `SubscriptionEffectiveProjection`, whose
   *    base is `subscription_terms.base_traffic_limit_bytes` / `base_device_limit`
   *    — frozen when the term was created and never mutated afterwards;
   *  - the entitlement boundary sweep is event-driven (due add-on expiry, due
   *    SCHEDULED term) and never scans the plan table.
   *
   * The edit lands at the subscriber's next renewal or upgrade. Upgrade
   * re-copies the plan unconditionally; renewal re-applies it to exactly those
   * fields whose columns still match this snapshot — which, now that the four
   * are frozen, is everyone who was never individually adjusted. That is the
   * rule the plan editor states to the operator while they are typing
   * (`web/src/i18n/en.ts` → `plans.form.limitScope`).
   *
   * ── Why deferral is the rule, and not an oversight ───────────────────────
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
   * subscription columns AND these four snapshot keys AND the ACTIVE term's
   * baseline AND rerun `EffectiveProjectionService.recomputeInTransaction` to
   * advance `desiredRevision`. Miss any one and you reproduce, at fan-out
   * scale, the split-brain `upgradeSubscriptionFromPayment` already has: it
   * moves the columns and leaves the term stale, so with `projectionSync` on
   * the next versioned job pushes the OLD baseline back. Build it after the
   * entitlement cutover picks a single owner, not before.
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
      // MIRRORED — display facts. A renamed or re-tagged plan must not keep
      // showing its old label on the cabinet card, in the bot, or on an invoice.
      planSnapshot.name = plan.name;
      planSnapshot.tag = plan.tag;
      planSnapshot.type = plan.type;
      // Mirrored too, and NOT display-only: `ProfileSyncProcessor` reads
      // `trafficLimitStrategy` out of this JSON and pushes it to the panel. It
      // is not one of the four the override rule compares, and the subscription
      // editor exposes no per-subscription field for it, so the plan row stays
      // its single owner and mirroring it cannot erase an operator's choice.
      planSnapshot.trafficLimitStrategy = plan.trafficLimitStrategy;

      // FROZEN — `icon`, and the four inherited-limit keys. Do not add them
      // back "for consistency"; both omissions are load-bearing.
      //
      // `icon` is frozen at purchase time: a customer's card must not change
      // its glyph because the operator restyled the plan.
      //
      // `trafficLimit` / `deviceLimit` / `internalSquads` / `externalSquad` are
      // frozen because they are the BASELINE for override detection —
      // `resolveInheritedPlanLimitUpdate` decides whether an operator
      // individually adjusted a subscription by comparing its columns against
      // exactly these keys. Mirroring them made the snapshot track the live
      // plan rather than what the plan gave THIS subscription, so one plan edit
      // made every never-adjusted subscriber read as overridden and pinned
      // their limits forever. They stay on `SnapshotSyncPlanInput` above so the
      // call site can keep handing over a whole plan row.
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
