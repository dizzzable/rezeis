import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, SubscriptionStatus } from '@prisma/client';

import { writeResetRulePushesInTransaction } from '../../add-on-entitlements/services/reset-rule-follow';
import { TrafficLimitStrategyValue } from '../../plans/dto/traffic-limit-strategy.dto';

/** Marks the push a changed reset rule queues for each live subscriber (`reset-rule-follow.ts`). */
export { PLAN_STRATEGY_UPDATE_CAUSE } from '../../add-on-entitlements/services/reset-rule-follow';

export interface PlanSnapshotSyncResult {
  /** Subscriptions whose snapshot was rewritten. */
  readonly updated: number;
  /** Of those, the ones whose reset rule the edit changed (DELETED rows aside). */
  readonly strategyChanged: number;
  /**
   * Of those, the ones in the term model — with an ACTIVE or SCHEDULED term of
   * the plan — for the caller to hand to `followResetRules` once its
   * transaction has COMMITTED: their terms and «до сброса» add-ons follow the
   * new rule, and then a live one is pushed to Remnawave — each in a short
   * transaction of its own (`reset-rule-follow.ts`). One a crash cuts short is
   * found again by its terms (the boundary scheduler's sweep).
   */
  readonly followSubscriptionIds: readonly string[];
  /**
   * The pushes written IN this transaction for the others — live, linked,
   * nothing to follow (review R4-01) — for the caller to enqueue once it has
   * committed. After a crash the profile-sync sweep sends them.
   */
  readonly syncJobIds: readonly string[];
}

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

type MirroredSubscriptionRow = {
  readonly id: string;
  /** The rule the snapshot named before this write; `null` when it named none. */
  readonly previousStrategy: string | null;
  readonly status: string;
  /** Linked to a Remnawave profile. */
  readonly linked: boolean;
  /** Has an ACTIVE or SCHEDULED term of the plan — what the follow's sweep can find. */
  readonly inModel: boolean;
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
   * scale, the split-brain a paid upgrade once had: it moved the columns and
   * left the term stale, so the next recompute pushed the OLD baseline back.
   * Build it after the entitlement cutover picks a single owner, not before.
   *
   * ── A changed RESET RULE is not deferred (P6, 24.09.2026) ────────────────
   *
   * The strategy is no priced good: Remnawave runs whatever the panel last
   * pushed, and until this edit reached a subscriber with its next unrelated
   * push, Remnawave reset them by the old rule while the panel's «до сброса»
   * add-ons ended by it too. So, for each subscriber whose stored rule the
   * edit changes: its terms of this plan take the new rule
   * (`SubscriptionTermService.followResetRuleInTransaction`), its live «до
   * сброса» add-ons end at the first reset under it (never later than
   * promised), and a push goes out at once for a live linked profile — a
   * fan-out, like the squads' (`PlanSquadPropagationService`). A snapshot that
   * names no rule of its own (an old import) changes nothing here: its rule
   * was never the panel's to date anything by.
   *
   * ── …but NOT in this transaction (R3a-01, 25.09.2026) ────────────────────
   *
   * That per-subscriber work used to run in here, inside the plan edit's one
   * interactive transaction with Prisma's 5-second timeout — some 4.7 ms a
   * subscriber, so the rule of a plan that ever had about 1,000 buyers could
   * not be changed at all: P2028, everything rolled back. This method now
   * writes the snapshots in ONE statement whatever the plan's size, and
   * RETURNS the subscribers in the term model whose rule changed; the caller
   * hands them to `followResetRules` (`reset-rule-follow.ts`) once it has
   * committed — one short transaction per subscriber, each push enqueued right
   * after its commit, and the boundary scheduler's sweep finishing whatever a
   * crash left behind (the terms that still name the old rule say so).
   *
   * A subscriber OUTSIDE the term model has no terms to say so (review R4-01):
   * a crash before the follow reached it lost its push for good. So its push
   * is written here, in the edit's transaction, in ONE more statement
   * (`writeResetRulePushesInTransaction`) — as durable as the new rule itself —
   * and handed back for the caller to enqueue once it has committed.
   */
  public async syncPlanSnapshotMetadata(
    prismaClient: Prisma.TransactionClient | PrismaClient,
    plan: SnapshotSyncPlanInput,
    options: { readonly now?: Date } = {},
  ): Promise<PlanSnapshotSyncResult> {
    // MIRRORED — display facts: `name`, `tag`, `type`. A renamed or re-tagged
    // plan must not keep showing its old label on the cabinet card, in the
    // bot, or on an invoice. And `trafficLimitStrategy`, which is NOT
    // display-only: `ProfileSyncProcessor` reads it out of this JSON and pushes
    // it to the panel. It is not one of the four the override rule compares,
    // and the subscription editor exposes no per-subscription field for it, so
    // the plan row stays its single owner and mirroring it cannot erase an
    // operator's choice.
    //
    // FROZEN — `icon`, and the four inherited-limit keys: the `||` merge below
    // writes the four keys above and leaves every other key as it is. Do not
    // add them "for consistency"; both omissions are load-bearing. `icon` is
    // frozen at purchase time: a customer's card must not change its glyph
    // because the operator restyled the plan. `trafficLimit` / `deviceLimit` /
    // `internalSquads` / `externalSquad` are the BASELINE for override
    // detection — `resolveInheritedPlanLimitUpdate` decides whether an operator
    // individually adjusted a subscription by comparing its columns against
    // exactly these keys. Mirroring them made the snapshot track the live plan
    // rather than what the plan gave THIS subscription, so one plan edit made
    // every never-adjusted subscriber read as overridden and pinned their
    // limits forever. They stay on `SnapshotSyncPlanInput` above so the call
    // site can keep handing over a whole plan row.
    //
    // ONE STATEMENT, merged in the database under each row's lock: the rule
    // each snapshot named BEFORE the write comes back from the locking read in
    // the same statement, so it cannot be raced, and no other key of the JSON
    // is written back from a stale copy. With it, whether the row is in the
    // term model by the very test the follow's sweep finds work by (an ACTIVE
    // or SCHEDULED term of the snapshot's plan): what the sweep can find is
    // followed after the commit, what it cannot is pushed from here. Every
    // writer of a term takes this row's lock first, so the answer holds until
    // the commit.
    const now = options.now ?? new Date();
    const rows = await prismaClient.$queryRaw<MirroredSubscriptionRow[]>(Prisma.sql`
      WITH "previous" AS (
        SELECT "id", "plan_snapshot"->>'trafficLimitStrategy' AS "previousStrategy"
          FROM "subscriptions"
         WHERE "plan_snapshot"->>'id' = ${plan.id}
           FOR UPDATE
      )
      UPDATE "subscriptions" AS s
         SET "plan_snapshot" = s."plan_snapshot" || jsonb_build_object(
               'name', ${plan.name}::text,
               'tag', ${plan.tag}::text,
               'type', ${plan.type}::text,
               'trafficLimitStrategy', ${plan.trafficLimitStrategy}::text
             ),
             "updated_at" = ${now}
        FROM "previous"
       WHERE s."id" = "previous"."id"
      RETURNING s."id", "previous"."previousStrategy", s."status"::text AS "status",
                s."remnawave_id" IS NOT NULL AS "linked",
                EXISTS (
                  SELECT 1
                    FROM "subscription_terms" t
                   WHERE t."subscription_id" = s."id"
                     AND t."status" IN ('ACTIVE', 'SCHEDULED')
                     AND t."plan_id" IS NOT DISTINCT FROM s."plan_snapshot"->>'id'
                ) AS "inModel"
    `);

    const changed = rows.filter(
      (row) =>
        row.status !== SubscriptionStatus.DELETED &&
        typeof row.previousStrategy === 'string' &&
        row.previousStrategy !== plan.trafficLimitStrategy,
    );
    const followSubscriptionIds = changed.filter((row) => row.inModel).map((row) => row.id);
    const pushNow = changed
      .filter(
        (row) =>
          !row.inModel &&
          row.linked &&
          (row.status === SubscriptionStatus.ACTIVE || row.status === SubscriptionStatus.LIMITED),
      )
      .map((row) => row.id);
    const syncJobIds = await writeResetRulePushesInTransaction(prismaClient, pushNow, { planId: plan.id, now });
    return { updated: rows.length, strategyChanged: changed.length, followSubscriptionIds, syncJobIds };
  }
}
