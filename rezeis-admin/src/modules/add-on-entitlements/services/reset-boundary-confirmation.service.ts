import { Injectable, Logger, Optional } from '@nestjs/common';
import { AddOnEntitlementState, AddOnLifetime, Prisma, ResetEpochCloseSource } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { RemnawaveProfileFactsService } from '../../remnawave/services/remnawave-profile-facts.service';
import { readAddOnRolloutFlags } from '../add-on-rollout.config';
import { entitlementEndBound } from '../domain/add-on-lifetime';
import { DEFAULT_REMNAWAVE_TIME_ZONE, RESET_EXPIRY_MARGIN_MS, type ResetStrategy } from '../domain/reset-cycle-policy';
import { AddOnSwitchesService } from '../switches/add-on-switches.service';
import { profilesOfRun, SCHEDULED_RUN_SLACK_MS } from '../switches/reset-schedule-check';
import { ownTrafficResetSql } from './own-traffic-resets';

/**
 * THE LIMIT DROP FOLLOWS THE COUNTER RESET
 * ════════════════════════════════════════
 * An add-on sold «до сброса трафика» ends at Remnawave's reset: it is taken off
 * {@link RESET_EXPIRY_MARGIN_MS} after the reset instant the panel predicts,
 * and the base limit goes to Remnawave. Taken off BEFORE Remnawave actually
 * zeroed the counter, it switches every customer who used the extra traffic to
 * LIMITED — the «трафик закончился» notice, the operator card, the
 * automations — until the reset comes. And the prediction can be wrong: an
 * operator's `TZ` the panel was not told about, a Remnawave scheduler that was
 * down at the minute (a missed run is not caught up — W7 §1.1).
 *
 * So the sweep takes such an add-on off only once its `expiresAt` has passed
 * AND Remnawave's reset is CONFIRMED:
 *  - DAY / WEEK / MONTH — Remnawave resets every profile of the strategy in
 *    one batch, and stamps them with one instant per STATUS GROUP: the run's
 *    `now` (W7 §1.1), and the LIMITED ones about ten milliseconds later (the S4
 *    lab; review R4-03). So the boundary is confirmed for everybody by the RUN
 *    — two or more profiles of the strategy stamped within the batch window at
 *    one instant, give or take `RUN_STAMP_SPREAD_MS`, or one stamped
 *    within seconds after the planned instant, the shape only the cron minute
 *    has ({@link showsScheduledRun}) — never by one subscriber's own reset.
 *    Before (review R3a-04) any stamped reset within
 *    the hour confirmed the boundary: one customer who renewed at 00:25 took
 *    everyone's add-ons off although Remnawave had missed its 00:05 run, and
 *    their counters were never zeroed. The panel's own resets (a renewal, the
 *    operator's «Сбросить», «Обнулить трафик») are never evidence of a run
 *    (`own-traffic-resets.ts`). What is stamped is looked at first; else one
 *    or two sample profiles are read now (`RemnawaveProfileFactsService`,
 *    which stamps what it reads).
 *    A subscriber whose OWN counter was zeroed at or after the planned instant
 *    — by the run, a renewal, anything — has nothing left to wait for, and
 *    its own epochs close (`closeOwnResets`); that confirms nothing
 *    for the others. It is also what an install with ONE profile on the
 *    strategy relies on, where no instant can be shared: that profile's reset
 *    releases its own add-on, and without one it is held until the hold runs
 *    out, with the incident — which is then true.
 *  - MONTH_ROLLING — each profile has its own day, so each subscription
 *    confirms for itself: its own `remnawave_last_traffic_reset_at` at or after
 *    the planned reset (less {@link RESET_CONFIRMATION_TOLERANCE_MS}), read from
 *    Remnawave when what is stamped does not say so yet.
 * A confirmed boundary is CLOSED — `SubscriptionResetEpoch.closedAt`,
 * `closeSource = WEBHOOK_RECONCILIATION` — and its add-ons are then due like
 * any other. Until then they are HELD: still ACTIVE, still counted, and left
 * out of the sweep's window ({@link resetAddOnHeldSql}), so a boundary that
 * never confirms cannot stand in front of anything else.
 *
 * A hold ends after {@link RESET_CONFIRMATION_HOLD_MS} whatever happened: the
 * boundary is closed on the panel's clock (`closeSource = SCHEDULER`), the
 * add-ons expire, and ONE incident per boundary tells the operator to check
 * «Часовой пояс Remnawave» and Remnawave's scheduler.
 *
 * WHICH ADD-ONS WAIT. Only one that ends AT the reset — `entitlementEndBound`
 * says `'reset'`: an `UNTIL_NEXT_RESET` entitlement whose `expiresAt` is its
 * epoch's reset plus the margin. One the subscription's end cut short ends
 * with the subscription, and waits for nothing.
 */

/** The longest an add-on ending at a reset is held past its own `expiresAt` for want of confirmation. */
export const RESET_CONFIRMATION_HOLD_MS = 6 * 60 * 60 * 1000;

/**
 * How much EARLIER than the planned instant an observed reset still confirms
 * it: the panel's and Remnawave's clocks are not the same clock. Remnawave's
 * jobs fire within tens of milliseconds of the minute (lab, 25.09.2026).
 */
export const RESET_CONFIRMATION_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * How LATE after the planned instant a sample profile's reset still reads as
 * the scheduled batch of a calendar strategy, rather than somebody's manual
 * reset hours later. Generous: the batch waits behind any reset job running
 * before it (one queue, concurrency 1) and writes 50 000 users per statement.
 */
export const CALENDAR_BATCH_WINDOW_MS = 60 * 60 * 1000;

/** Sample profiles read per calendar boundary per check. */
export const CALENDAR_CONFIRMATION_SAMPLES = 2;

/** A boundary or a subscription found unconfirmed is not asked again for this long. */
export const UNCONFIRMED_RECHECK_MS = 10 * 60 * 1000;

/** Open boundaries looked at per sweep tick. */
const MAX_BOUNDARIES_PER_TICK = 50;

/** Held rolling subscriptions examined per boundary per tick. */
const MAX_ROLLING_PER_BOUNDARY = 200;

/** Profiles read per tick, all boundaries together — Remnawave is not a bulk source here. */
const MAX_READS_PER_TICK = 30;

/** Reads in a row that learnt nothing before this tick stops reading: the panel is down. */
const MAX_FAILED_READS_IN_A_ROW = 3;

/** The in-memory memo never grows past this; past it, it starts over. */
const MEMO_LIMIT = 10_000;

/** `interval '1 millisecond' * n`, for a millisecond constant in SQL. */
function msInterval(ms: number): Prisma.Sql {
  return Prisma.sql`(interval '1 millisecond' * ${ms}::double precision)`;
}

/**
 * THE HOLD, IN SQL — over `add_on_entitlements e` LEFT JOIN
 * `subscription_reset_epochs ep ON ep.id = e.expiry_epoch_id`: true for an
 * ACTIVE add-on that ends at a reset (`entitlementEndBound`'s rule, restated:
 * `UNTIL_NEXT_RESET`, bound to an epoch, `expires_at >= planned + margin`)
 * whose boundary is still open and whose hold has not run out. Never NULL, so
 * `NOT (…)` of it keeps every other row.
 */
export function resetAddOnHeldSql(now: Date): Prisma.Sql {
  return Prisma.sql`COALESCE(
    e."state" = 'ACTIVE'
    AND e."lifetime" = 'UNTIL_NEXT_RESET'
    AND ep."planned_ends_at" IS NOT NULL
    AND e."expires_at" >= ep."planned_ends_at" + ${msInterval(RESET_EXPIRY_MARGIN_MS)}
    AND ep."closed_at" IS NULL
    AND e."expires_at" + ${msInterval(RESET_CONFIRMATION_HOLD_MS)} > ${now},
    false
  )`;
}

/** An entitlement as the boundary reads it, with its epoch. */
export interface HoldableEntitlement {
  readonly state: AddOnEntitlementState;
  readonly lifetime: AddOnLifetime;
  readonly expiresAt: Date | null;
  readonly expiryEpoch: { readonly plannedEndsAt: Date; readonly closedAt: Date | null } | null;
}

/** {@link resetAddOnHeldSql}, for a row already read — the one rule, in the two places the sweep needs it. */
export function isHeldForResetConfirmation(row: HoldableEntitlement, now: Date): boolean {
  // `== null`: a row read without its epoch or end holds nothing.
  if (row.state !== AddOnEntitlementState.ACTIVE || row.expiresAt == null || row.expiryEpoch == null) return false;
  const bound = entitlementEndBound({
    lifetime: row.lifetime,
    expiresAt: row.expiresAt,
    epochPlannedEndsAt: row.expiryEpoch.plannedEndsAt,
  });
  return (
    bound === 'reset' &&
    row.expiryEpoch.closedAt === null &&
    row.expiresAt.getTime() + RESET_CONFIRMATION_HOLD_MS > now.getTime()
  );
}

/** Does an observed reset fall within the batch window of the calendar boundary at `plannedAt`? */
export function confirmsCalendarReset(observed: Date | null, plannedAt: Date): boolean {
  if (observed === null) return false;
  const delta = observed.getTime() - plannedAt.getTime();
  return delta >= -RESET_CONFIRMATION_TOLERANCE_MS && delta <= CALENDAR_BATCH_WINDOW_MS;
}

/** One reset instant Remnawave stamped, and on how many profiles of the strategy. */
export interface StampedReset {
  readonly resetAt: Date;
  /** Profiles of the strategy stamped with exactly this instant, the panel's own resets left out. */
  readonly profiles: number;
}

/**
 * Does what is stamped show Remnawave's SCHEDULED RUN for the calendar
 * boundary at `plannedAt` — not one subscriber's reset? Within the batch
 * window ({@link confirmsCalendarReset}), an instant that is either
 *  - shared by two or more profiles of the strategy, give or take
 *    `RUN_STAMP_SPREAD_MS` (`reset-schedule-check.ts`): a run stamps the
 *    profiles it resets with one `now` per status group, the LIMITED ones a
 *    few milliseconds after the rest (review R4-03), and two resets that are
 *    not one run are never that close — the panel's own are left out first
 *    (`ownTrafficResetSql`); or
 *  - within {@link SCHEDULED_RUN_SLACK_MS} after the planned instant: the cron
 *    fires on the minute of Remnawave's own clock and stamps that clock, so a
 *    run on time lands there whatever the two clocks' difference — the one
 *    shape a lone profile can show (a run that waited behind another reset
 *    job lands later, and is recognised by the shared instant instead).
 * The panel's own resets are to be left out of `stamps` by the caller
 * (`ownTrafficResetSql`): a renewal from the auto-renew cron lands a second
 * after a whole minute too.
 */
export function showsScheduledRun(stamps: readonly StampedReset[], plannedAt: Date): boolean {
  const inWindow = stamps.filter((stamp) => confirmsCalendarReset(stamp.resetAt, plannedAt));
  const instants = inWindow.map((stamp) => ({ at: stamp.resetAt.getTime(), profiles: stamp.profiles }));
  return inWindow.some((stamp) => {
    const late = stamp.resetAt.getTime() - plannedAt.getTime();
    return profilesOfRun(instants, stamp.resetAt.getTime()) >= 2 || (late >= 0 && late <= SCHEDULED_RUN_SLACK_MS);
  });
}

/** Does a subscription's own observed reset confirm its rolling boundary at `plannedAt`? */
export function confirmsOwnReset(observed: Date | null, plannedAt: Date): boolean {
  return observed !== null && observed.getTime() >= plannedAt.getTime() - RESET_CONFIRMATION_TOLERANCE_MS;
}

/** One open boundary with add-ons waiting on it. */
interface OpenBoundary {
  readonly strategy: ResetStrategy;
  readonly plannedAt: Date;
}

/** What one confirmation pass did. */
export interface ResetConfirmationSummary {
  /** Boundaries closed because Remnawave's reset was observed. */
  readonly confirmed: number;
  /** Boundaries closed because the hold ran out (each raised one incident). */
  readonly capped: number;
  /** Boundaries still held. */
  readonly held: number;
  /** Profiles read from Remnawave. */
  readonly reads: number;
}

/** The Russian name of a strategy, as the plan editor shows it. */
const STRATEGY_LABEL: Readonly<Record<ResetStrategy, string>> = {
  NO_RESET: 'Без сброса',
  DAY: 'Каждый день',
  WEEK: 'Каждую неделю',
  MONTH: 'Ежемесячно (по календарю, 1-го числа)',
  MONTH_ROLLING: 'Ежемесячно (по дате создания)',
};

/** `2026-10-01 00:20 UTC` — one unambiguous spelling for an operator who runs Remnawave in another zone. */
function utcMinute(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Confirms Remnawave's traffic resets before the boundary sweep takes the
 * add-ons ending at them off — see the header of this file. Run by the sweep
 * (`EntitlementBoundarySchedulerService.runDueBoundaries`) right before it
 * selects what is due, once per tick.
 */
@Injectable()
export class ResetBoundaryConfirmationService {
  private readonly logger = new Logger(ResetBoundaryConfirmationService.name);
  /** `strategy:planned[:subscription]` → until when an unconfirmed check is not repeated. */
  private readonly unconfirmedUntil = new Map<string, number>();

  public constructor(
    private readonly prismaService: PrismaService,
    /** Reads a profile once and stamps it; without it only what is stamped confirms. */
    @Optional() private readonly profileFacts?: RemnawaveProfileFactsService,
    /** The incident at the end of a hold; `@Optional()` for the specs that build this by hand. */
    @Optional() private readonly systemEvents?: SystemEventsService,
    /** «Часовой пояс Remnawave», named in the incident. */
    @Optional() private readonly addOnSwitches?: AddOnSwitchesService,
  ) {}

  public async confirmDueBoundaries(now: Date = new Date()): Promise<ResetConfirmationSummary> {
    const boundaries = await this.openBoundaries(now);
    const budget = { reads: 0, failedInARow: 0 };
    let confirmed = 0;
    let capped = 0;
    let held = 0;
    for (const boundary of boundaries) {
      try {
        if (now.getTime() >= boundary.plannedAt.getTime() + RESET_EXPIRY_MARGIN_MS + RESET_CONFIRMATION_HOLD_MS) {
          if (await this.closeUnconfirmed(boundary, now)) capped += 1;
          continue;
        }
        const outcome =
          boundary.strategy === 'MONTH_ROLLING'
            ? await this.confirmRolling(boundary, now, budget)
            : await this.confirmCalendar(boundary, now, budget);
        if (outcome === 'confirmed') confirmed += 1;
        else held += 1;
      } catch (error: unknown) {
        this.logger.warn(
          `Reset confirmation failed for ${boundary.strategy} at ${boundary.plannedAt.toISOString()}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { confirmed, capped, held, reads: budget.reads };
  }

  /** Open boundaries with at least one add-on due and waiting on them, the oldest first. */
  private async openBoundaries(now: Date): Promise<OpenBoundary[]> {
    const rows = await this.prismaService.$queryRaw<Array<{ strategy: ResetStrategy; plannedAt: Date }>>(Prisma.sql`
      SELECT t."traffic_reset_strategy"::text AS "strategy", ep."planned_ends_at" AS "plannedAt"
      FROM "add_on_entitlements" e
      JOIN "subscription_reset_epochs" ep ON ep."id" = e."expiry_epoch_id"
      JOIN "subscription_terms" t ON t."id" = ep."term_id"
      WHERE e."state" = 'ACTIVE'
        AND e."lifetime" = 'UNTIL_NEXT_RESET'
        AND e."expires_at" IS NOT NULL
        AND e."expires_at" <= ${now}
        AND e."expires_at" >= ep."planned_ends_at" + ${msInterval(RESET_EXPIRY_MARGIN_MS)}
        AND ep."closed_at" IS NULL
      GROUP BY t."traffic_reset_strategy", ep."planned_ends_at"
      ORDER BY ep."planned_ends_at" ASC, t."traffic_reset_strategy" ASC
      LIMIT ${MAX_BOUNDARIES_PER_TICK}
    `);
    return rows.map((row) => ({ strategy: row.strategy, plannedAt: new Date(row.plannedAt) }));
  }

  /**
   * DAY / WEEK / MONTH: one batch resets every profile of the strategy with
   * ONE instant, so the RUN confirms the boundary for all
   * ({@link showsScheduledRun}); a subscriber's own reset releases only its
   * own add-on ({@link closeOwnResets}). First what is stamped, then the
   * samples read now — whose answers are stamped, and looked at the same way.
   */
  private async confirmCalendar(
    boundary: OpenBoundary,
    now: Date,
    budget: { reads: number; failedInARow: number },
  ): Promise<'confirmed' | 'held'> {
    const key = `${boundary.strategy}:${boundary.plannedAt.toISOString()}`;
    if (showsScheduledRun(await this.stampedResets(boundary), boundary.plannedAt)) {
      return this.closeConfirmed(boundary, now, null);
    }
    if ((await this.closeOwnResets(boundary, now)) === 0) return 'confirmed';

    if (this.recentlyUnconfirmed(key, now)) return 'held';
    const samples = await this.prismaService.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT DISTINCT s."id"
      FROM "add_on_entitlements" e
      JOIN "subscription_reset_epochs" ep ON ep."id" = e."expiry_epoch_id"
      JOIN "subscription_terms" t ON t."id" = ep."term_id"
      JOIN "subscriptions" s ON s."id" = e."subscription_id"
      WHERE t."traffic_reset_strategy"::text = ${boundary.strategy}
        AND ep."planned_ends_at" = ${boundary.plannedAt}
        AND ep."closed_at" IS NULL
        AND e."state" = 'ACTIVE'
        AND s."status" <> 'DELETED'
        AND s."remnawave_id" IS NOT NULL
      LIMIT ${CALENDAR_CONFIRMATION_SAMPLES}
    `);
    let read = 0;
    for (const sample of samples) {
      const observed = await this.readReset(sample.id, now, budget);
      if (observed === undefined) break;
      read += 1;
    }
    if (read === 0) return 'held'; // this tick's reads spent, or the panel down: the next tick asks
    // What the reads stamped, judged as what was stamped before.
    if (showsScheduledRun(await this.stampedResets(boundary), boundary.plannedAt)) {
      return this.closeConfirmed(boundary, now, null);
    }
    if ((await this.closeOwnResets(boundary, now)) === 0) return 'confirmed';
    // Asked and not confirmed: not again for a while.
    this.markUnconfirmed(key, now);
    return 'held';
  }

  /**
   * The reset instants stamped within the batch window on profiles of the
   * boundary's strategy — the ones the panel pushes it for, by their ACTIVE
   * term or, outside the term model, their snapshot — each with how many
   * profiles carry it. The panel's own resets are left out
   * (`ownTrafficResetSql`): they are no run of Remnawave's.
   */
  private async stampedResets(boundary: OpenBoundary): Promise<StampedReset[]> {
    const rows = await this.prismaService.$queryRaw<Array<{ resetAt: Date; profiles: number }>>(Prisma.sql`
      SELECT s."remnawave_last_traffic_reset_at" AS "resetAt", COUNT(*)::int AS "profiles"
      FROM "subscriptions" s
      WHERE s."status" <> 'DELETED'
        AND s."remnawave_last_traffic_reset_at" >= ${new Date(boundary.plannedAt.getTime() - RESET_CONFIRMATION_TOLERANCE_MS)}
        AND s."remnawave_last_traffic_reset_at" <= ${new Date(boundary.plannedAt.getTime() + CALENDAR_BATCH_WINDOW_MS)}
        AND (
          EXISTS (
            SELECT 1
            FROM "subscription_terms" t
            WHERE t."subscription_id" = s."id"
              AND t."status" = 'ACTIVE'
              AND t."traffic_reset_strategy"::text = ${boundary.strategy}
          )
          OR s."plan_snapshot"->>'trafficLimitStrategy' = ${boundary.strategy}
        )
        AND NOT ${ownTrafficResetSql(Prisma.sql`s."id"`, Prisma.sql`s."remnawave_last_traffic_reset_at"`)}
      GROUP BY s."remnawave_last_traffic_reset_at"
    `);
    return rows.map((row) => ({ resetAt: new Date(row.resetAt), profiles: Number(row.profiles) }));
  }

  /**
   * Releases the subscribers of the boundary whose OWN counter Remnawave
   * zeroed at or after the planned instant (less the clock tolerance) — the
   * run, a renewal, the operator, whoever: they have nothing left to wait for.
   * Their epochs close as confirmed; nobody else's does. Returns how many
   * subscriptions still wait on the boundary.
   */
  private async closeOwnResets(boundary: OpenBoundary, now: Date): Promise<number> {
    await this.prismaService.$executeRaw(Prisma.sql`
      UPDATE "subscription_reset_epochs" AS ep
         SET "closed_at" = ${now}, "close_source" = ${ResetEpochCloseSource.WEBHOOK_RECONCILIATION}::"ResetEpochCloseSource"
        FROM "subscription_terms" AS t, "subscriptions" AS s
       WHERE t."id" = ep."term_id"
         AND s."id" = t."subscription_id"
         AND t."traffic_reset_strategy"::text = ${boundary.strategy}
         AND ep."planned_ends_at" = ${boundary.plannedAt}
         AND ep."closed_at" IS NULL
         AND s."remnawave_last_traffic_reset_at" >= ${new Date(boundary.plannedAt.getTime() - RESET_CONFIRMATION_TOLERANCE_MS)}
    `);
    const [waiting] = await this.prismaService.$queryRaw<Array<{ subscriptions: number }>>(Prisma.sql`
      SELECT COUNT(DISTINCT e."subscription_id")::int AS "subscriptions"
      FROM "add_on_entitlements" e
      JOIN "subscription_reset_epochs" ep ON ep."id" = e."expiry_epoch_id"
      JOIN "subscription_terms" t ON t."id" = ep."term_id"
      WHERE t."traffic_reset_strategy"::text = ${boundary.strategy}
        AND ep."planned_ends_at" = ${boundary.plannedAt}
        AND ep."closed_at" IS NULL
        AND e."state" = 'ACTIVE'
        AND e."lifetime" = 'UNTIL_NEXT_RESET'
        AND e."expires_at" >= ep."planned_ends_at" + ${msInterval(RESET_EXPIRY_MARGIN_MS)}
    `);
    return Number(waiting?.subscriptions ?? 0);
  }

  /**
   * MONTH_ROLLING: each subscription confirms for itself — its own stamped
   * reset, or its profile read now. Those confirmed are closed one by one; the
   * boundary counts as confirmed when none is left waiting.
   */
  private async confirmRolling(
    boundary: OpenBoundary,
    now: Date,
    budget: { reads: number; failedInARow: number },
  ): Promise<'confirmed' | 'held'> {
    const waiting = await this.prismaService.$queryRaw<Array<{ id: string; lastReset: Date | null }>>(Prisma.sql`
      SELECT DISTINCT s."id", s."remnawave_last_traffic_reset_at" AS "lastReset"
      FROM "add_on_entitlements" e
      JOIN "subscription_reset_epochs" ep ON ep."id" = e."expiry_epoch_id"
      JOIN "subscription_terms" t ON t."id" = ep."term_id"
      JOIN "subscriptions" s ON s."id" = e."subscription_id"
      WHERE t."traffic_reset_strategy" = 'MONTH_ROLLING'
        AND ep."planned_ends_at" = ${boundary.plannedAt}
        AND ep."closed_at" IS NULL
        AND e."state" = 'ACTIVE'
        AND e."lifetime" = 'UNTIL_NEXT_RESET'
        AND e."expires_at" <= ${now}
        AND e."expires_at" >= ep."planned_ends_at" + ${msInterval(RESET_EXPIRY_MARGIN_MS)}
      ORDER BY s."id"
      LIMIT ${MAX_ROLLING_PER_BOUNDARY}
    `);
    const confirmedIds: string[] = [];
    let left = 0;
    for (const row of waiting) {
      if (confirmsOwnReset(row.lastReset === null ? null : new Date(row.lastReset), boundary.plannedAt)) {
        confirmedIds.push(row.id);
        continue;
      }
      const key = `MONTH_ROLLING:${boundary.plannedAt.toISOString()}:${row.id}`;
      if (this.recentlyUnconfirmed(key, now)) {
        left += 1;
        continue;
      }
      const observed = await this.readReset(row.id, now, budget);
      if (observed !== undefined && confirmsOwnReset(observed, boundary.plannedAt)) {
        confirmedIds.push(row.id);
      } else {
        if (observed !== undefined) this.markUnconfirmed(key, now);
        left += 1;
      }
    }
    if (confirmedIds.length > 0) await this.closeConfirmed(boundary, now, confirmedIds);
    return left === 0 && waiting.length > 0 ? 'confirmed' : 'held';
  }

  /**
   * The profile's reset as Remnawave states it now (stamped by the read), `null`
   * when the read learnt nothing, or `undefined` when this tick may not read any
   * more — its budget spent, or the panel not answering.
   */
  private async readReset(
    subscriptionId: string,
    now: Date,
    budget: { reads: number; failedInARow: number },
  ): Promise<Date | null | undefined> {
    if (this.profileFacts === undefined) return undefined;
    if (budget.reads >= MAX_READS_PER_TICK || budget.failedInARow >= MAX_FAILED_READS_IN_A_ROW) return undefined;
    budget.reads += 1;
    const facts = await this.profileFacts.refreshProfileFacts(subscriptionId, now);
    budget.failedInARow = facts === null ? budget.failedInARow + 1 : 0;
    return facts?.lastTrafficResetAt ?? null;
  }

  /** Closes the boundary — for `subscriptionIds` alone, or all of it — as confirmed by Remnawave. */
  private async closeConfirmed(
    boundary: OpenBoundary,
    now: Date,
    subscriptionIds: readonly string[] | null,
  ): Promise<'confirmed'> {
    const closed = await this.close(boundary, now, ResetEpochCloseSource.WEBHOOK_RECONCILIATION, subscriptionIds);
    this.unconfirmedUntil.delete(`${boundary.strategy}:${boundary.plannedAt.toISOString()}`);
    if (closed > 0) {
      this.logger.log(
        `Remnawave reset confirmed: ${boundary.strategy} at ${boundary.plannedAt.toISOString()} ` +
          `(${closed} epoch(s) closed)`,
      );
    }
    return 'confirmed';
  }

  /**
   * The hold ran out: closed on the panel's clock, so the add-ons expire now,
   * and ONE incident for the boundary — raised only by the pass that closed
   * it (`closed_at IS NULL` is the fence), so a boundary cannot raise two.
   */
  private async closeUnconfirmed(boundary: OpenBoundary, now: Date): Promise<boolean> {
    const subscriptions = await this.prismaService.$queryRaw<Array<{ subscriptions: number }>>(Prisma.sql`
      SELECT COUNT(DISTINCT t."subscription_id")::int AS "subscriptions"
      FROM "subscription_reset_epochs" ep
      JOIN "subscription_terms" t ON t."id" = ep."term_id"
      WHERE t."traffic_reset_strategy"::text = ${boundary.strategy}
        AND ep."planned_ends_at" = ${boundary.plannedAt}
        AND ep."closed_at" IS NULL
    `);
    const closed = await this.close(boundary, now, ResetEpochCloseSource.SCHEDULER, null);
    if (closed === 0) return false;
    await this.raiseIncident(boundary, subscriptions[0]?.subscriptions ?? closed);
    return true;
  }

  private async close(
    boundary: OpenBoundary,
    now: Date,
    source: ResetEpochCloseSource,
    subscriptionIds: readonly string[] | null,
  ): Promise<number> {
    return this.prismaService.$executeRaw(Prisma.sql`
      UPDATE "subscription_reset_epochs" AS ep
         SET "closed_at" = ${now}, "close_source" = ${source}::"ResetEpochCloseSource"
        FROM "subscription_terms" AS t
       WHERE t."id" = ep."term_id"
         AND t."traffic_reset_strategy"::text = ${boundary.strategy}
         AND ep."planned_ends_at" = ${boundary.plannedAt}
         AND ep."closed_at" IS NULL
         ${subscriptionIds === null ? Prisma.empty : Prisma.sql`AND t."subscription_id" = ANY(${[...subscriptionIds]}::text[])`}
    `);
  }

  private async raiseIncident(boundary: OpenBoundary, subscriptions: number): Promise<void> {
    let zone = DEFAULT_REMNAWAVE_TIME_ZONE;
    try {
      zone = (await readAddOnRolloutFlags(this.addOnSwitches)).remnawaveTimeZone ?? DEFAULT_REMNAWAVE_TIME_ZONE;
    } catch {
      // The zone only names what the prediction used; the incident goes out without it.
    }
    const planned = utcMinute(boundary.plannedAt);
    const label = STRATEGY_LABEL[boundary.strategy];
    this.logger.error(
      `Remnawave did not confirm the ${boundary.strategy} traffic reset planned for ${boundary.plannedAt.toISOString()} ` +
        `within ${RESET_CONFIRMATION_HOLD_MS / 3_600_000} h; the add-ons ending at it were taken off anyway ` +
        `(${subscriptions} subscription(s))`,
    );
    this.systemEvents?.error(
      EVENT_TYPES.SYSTEM_ERROR,
      'SYSTEM',
      `Remnawave did not confirm the ${boundary.strategy} traffic reset planned for ${planned}; ` +
        `add-ons ending at it were taken off without confirmation (${subscriptions} subscription(s))`,
      {
        reason: 'remnawave_reset_unconfirmed',
        strategy: boundary.strategy,
        plannedResetAt: boundary.plannedAt.toISOString(),
        remnawaveTimeZone: zone,
        subscriptions,
        why:
          `Remnawave не сбросил трафик по расписанию. Сброс «${label}» ожидался ${planned} ` +
          `(«Часовой пояс Remnawave»: ${zone}), но за ${RESET_CONFIRMATION_HOLD_MS / 3_600_000} ч после него ` +
          `Remnawave не подтвердил сброс. Докупки трафика «до сброса» у ${subscriptions} подписок сняты без ` +
          'подтверждения: если счётчик в Remnawave не обнулился, у клиентов, израсходовавших базовый лимит, ' +
          'трафик может закончиться до следующего сброса.',
        nextSteps:
          'Проверьте «Часовой пояс Remnawave» на странице «Доп. услуги» → «Настройки»: он должен совпадать со ' +
          'строкой TZ в .env сервера Remnawave (нет строки — UTC). Проверьте планировщик Remnawave: у профилей ' +
          `с этим правилом сброса в Remnawave «Последний сброс трафика» должен быть около ${planned}. ` +
          'Если сброса не было, сбросьте трафик этим профилям в Remnawave вручную.',
      },
    );
  }

  private recentlyUnconfirmed(key: string, now: Date): boolean {
    const until = this.unconfirmedUntil.get(key);
    return until !== undefined && until > now.getTime();
  }

  private markUnconfirmed(key: string, now: Date): void {
    if (this.unconfirmedUntil.size >= MEMO_LIMIT) this.unconfirmedUntil.clear();
    this.unconfirmedUntil.set(key, now.getTime() + UNCONFIRMED_RECHECK_MS);
  }
}
