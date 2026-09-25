import {
  AddOnEntitlementActorType,
  AddOnEntitlementState,
  AddOnLifetime,
  Prisma,
  TrafficLimitStrategy,
} from '@prisma/client';

import { readStoredRemnawaveTimeZone } from '../add-on-rollout.config';
import {
  planResetEpoch,
  provisionalResetAnchor,
  ResetCapability,
  ResetCyclePolicyError,
  ResetStrategy,
} from '../domain/reset-cycle-policy';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * The minimal live-epoch shape callers need to bind an entitlement's expiry.
 * `plannedEndsAt` is Remnawave's reset instant; the entitlement is taken off
 * `RESET_EXPIRY_MARGIN_MS` after it (`resetExpiryAt`), or earlier when the
 * subscription ends first.
 */
export interface LiveResetEpoch {
  readonly id: string;
  readonly startsAt: Date;
  readonly plannedEndsAt: Date;
}

export interface EnsureLiveResetEpochInput {
  readonly termId: string;
  readonly strategy: ResetStrategy;
  readonly anchorAt: Date | null;
  readonly capability: ResetCapability;
  readonly now: Date;
  /** «Часовой пояс Remnawave» (IANA); `undefined` means UTC. */
  readonly timeZone?: string;
}

/**
 * Find-or-create the reset epoch whose window CONTAINS `now` for a term
 * (T-008/T-016). This is the single, idempotent entry point for the reset-epoch
 * lifecycle:
 *  - first mint at term activation,
 *  - lazy mint for a term that was already ACTIVE when the reset-expiry flag
 *    was enabled (no activation event to mint it),
 *  - and cycle-advancement — each cycle's first purchase mints THAT cycle's
 *    epoch (the previous cycle's epoch simply stays with `plannedEndsAt <= now`
 *    and its bound entitlements expire via `expiresAt`).
 *
 * The window is computed purely from `planResetEpoch(strategy, anchorAt, now,
 * timeZone)` — Remnawave's own reset instants — so eligibility (which quotes
 * the same computation on the fly) and the money path (which binds to a
 * PERSISTED epoch) always agree.
 *
 * Returns `null` when there is no commercial reset window: `NO_RESET`,
 * capability not `ENABLED`, a null anchor, a zone the runtime does not know,
 * or a strategy/anchor that yields no epoch. What the caller does then is its
 * own rule; a paid reset quote never becomes a permanent increment
 * (`PaymentSubscriptionMutationService.applyAddOnViaLedger`).
 *
 * Idempotency & concurrency: the epoch table has `@@unique([termId,
 * plannedEndsAt])`. We fast-path a read of that window; on a miss we INSERT
 * under a Postgres SAVEPOINT. A concurrent same-window writer that committed
 * first makes our INSERT raise a unique violation (P2002) — WITHOUT the
 * savepoint that would abort the caller's whole interactive transaction
 * (Postgres 25P02), and Prisma's `upsert` is NOT a native `INSERT … ON
 * CONFLICT` (it is a read-then-write, equally race-prone — verified against
 * real Postgres). `ROLLBACK TO SAVEPOINT` un-aborts just the failed INSERT, and
 * we re-read the committed winner and return it. A residual `(termId, ordinal)`
 * collision for a DIFFERENT window (a cycle-boundary race, astronomically rare)
 * finds no winner for our window and is surfaced — but the transaction is
 * already healthy (rolled back to the savepoint), so the caller's `$transaction`
 * rolls back cleanly and the idempotent purchase can retry (no 25P02).
 */
export async function ensureLiveResetEpoch(
  tx: Prisma.TransactionClient,
  input: EnsureLiveResetEpochInput,
): Promise<LiveResetEpoch | null> {
  if (input.strategy === 'NO_RESET' || input.capability !== 'ENABLED' || input.anchorAt === null) {
    return null;
  }
  // A non-null but invalid anchor OR reference (NaN Date, a data anomaly) would
  // make planResetEpoch throw and roll back the caller's transaction — degrade
  // to the legacy path instead (matches eligibility's withhold-not-crash
  // intent). Callers pass `new Date()` for `now`, so the reference guard is
  // latent, but it keeps this helper total (never throws → never aborts tx).
  if (Number.isNaN(input.anchorAt.getTime()) || Number.isNaN(input.now.getTime())) return null;

  let plan: ReturnType<typeof planResetEpoch>;
  try {
    plan = planResetEpoch({
      strategy: input.strategy,
      capability: 'ENABLED',
      anchorAt: input.anchorAt,
      referenceAt: input.now,
      timeZone: input.timeZone,
    });
  } catch (error) {
    // An unknown «Часовой пояс Remnawave» (a value stored before its
    // validation, or a zone this runtime's tz data lacks) has no window —
    // the same total answer as a null anchor, never an aborted transaction.
    if (error instanceof ResetCyclePolicyError && error.code === 'INVALID_TIME_ZONE') return null;
    throw error;
  }
  if (plan === null) return null;

  return bindResetEpochWindow(tx, {
    termId: input.termId,
    startsAt: plan.startsAt,
    plannedEndsAt: plan.plannedEndsAt,
  });
}

/**
 * Find-or-create the epoch of an EXACT window on a term — the window a
 * checkout quoted (`add-on-quote.ts`), which the capture binds to whatever the
 * switches, the zone or the term say by then. Idempotent on `(termId,
 * plannedEndsAt)` and race-safe the way {@link ensureLiveResetEpoch} explains;
 * an epoch already recorded for the same reset is returned as it is.
 */
export async function bindResetEpochWindow(
  tx: Prisma.TransactionClient,
  input: { readonly termId: string; readonly startsAt: Date; readonly plannedEndsAt: Date },
): Promise<LiveResetEpoch> {
  const plan = { startsAt: input.startsAt, plannedEndsAt: input.plannedEndsAt };
  const existing = await findByWindow(tx, input.termId, plan.plannedEndsAt);
  if (existing !== null) return existing;

  const last = await tx.subscriptionResetEpoch.findFirst({
    where: { termId: input.termId },
    orderBy: { ordinal: 'desc' },
    select: { ordinal: true },
  });
  const ordinal = (last?.ordinal ?? 0) + 1;

  // Guard the INSERT with a savepoint so a concurrent-writer unique violation
  // rolls back ONLY this statement instead of aborting the caller's interactive
  // transaction. (Prisma's `create` generates the cuid `id`; a raw INSERT would
  // have to mint one itself.)
  await tx.$executeRawUnsafe('SAVEPOINT reset_epoch_mint');
  try {
    const created = await tx.subscriptionResetEpoch.create({
      data: {
        termId: input.termId,
        ordinal,
        startsAt: plan.startsAt,
        plannedEndsAt: plan.plannedEndsAt,
      },
      select: { id: true, startsAt: true, plannedEndsAt: true },
    });
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT reset_epoch_mint');
    return created;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Un-abort just the failed INSERT; the surrounding tx stays healthy.
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT reset_epoch_mint');
    // A concurrent writer committed the SAME window first → return the winner.
    const winner = await findByWindow(tx, input.termId, plan.plannedEndsAt);
    if (winner !== null) return winner;
    // No winner for our window → the collision was on (termId, ordinal) for a
    // DIFFERENT window (cycle-boundary race). Surface it; the tx is healthy.
    throw error;
  }
}

/**
 * «Часовой пояс Remnawave», read through the CALLER's transaction client — the
 * connection it already holds, so no second pool connection is taken while it
 * is held (review R2b-07). For the admin paths that change a reset rule inside
 * a transaction they did not open (a plan edit, a plan change) and have no
 * switches snapshot to take it from. `undefined` (UTC) when unset or unreadable.
 */
export async function readRemnawaveTimeZoneInTransaction(tx: Prisma.TransactionClient): Promise<string | undefined> {
  try {
    const row = await tx.settings.findFirst({ select: { addOnSettings: true } });
    return readStoredRemnawaveTimeZone(row?.addOnSettings);
  } catch {
    return undefined;
  }
}

/**
 * MONTH_ROLLING's anchor for a term minted now (P2), read through the caller's
 * transaction: the Remnawave profile's `createdAt` the panel stored on the
 * subscription (`remnawave_profile_created_at`), else the rolling anchor the
 * newest of its MONTH_ROLLING terms carries; `null` while neither is known.
 * Never a network read — the caller holds row locks.
 */
export async function readRollingResetAnchorInTransaction(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
): Promise<Date | null> {
  const subscription = await tx.subscription.findUnique({
    where: { id: subscriptionId },
    select: { remnawaveProfileCreatedAt: true },
  });
  if (subscription?.remnawaveProfileCreatedAt != null) return subscription.remnawaveProfileCreatedAt;
  const term = await tx.subscriptionTerm.findFirst({
    where: {
      subscriptionId,
      trafficResetStrategy: TrafficLimitStrategy.MONTH_ROLLING,
      resetAnchorAt: { not: null },
    },
    orderBy: { generation: 'desc' },
    select: { resetAnchorAt: true },
  });
  return term?.resetAnchorAt ?? null;
}

/**
 * The reset anchor a term on `strategy` starting at `startsAt` is minted with,
 * read through the caller's transaction: {@link provisionalResetAnchor} with
 * {@link readRollingResetAnchorInTransaction}, which is read only for
 * MONTH_ROLLING — the one strategy that counts from it.
 */
export async function mintResetAnchorInTransaction(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
  strategy: ResetStrategy,
  startsAt: Date,
): Promise<Date | null> {
  return provisionalResetAnchor(
    strategy,
    startsAt,
    strategy === 'MONTH_ROLLING' ? await readRollingResetAnchorInTransaction(tx, subscriptionId) : null,
  );
}

export interface RedateResetAddOnsInput {
  readonly subscriptionId: string;
  /** The reset rule the subscription runs from now on. */
  readonly strategy: ResetStrategy;
  /** MONTH_ROLLING: the Remnawave profile's `createdAt`; calendar strategies ignore it. */
  readonly anchorAt: Date | null;
  /** «Часовой пояс Remnawave»; `undefined` means UTC. */
  readonly timeZone?: string;
  readonly now: Date;
  readonly correlationId: string;
  /** The event reason, e.g. `RESET_RULE_CHANGED`. */
  readonly reason: string;
}

/**
 * A SUBSCRIPTION'S RESET RULE CHANGED — a plan edit, a plan change, a paid
 * upgrade (P6; the owner's rule of 24.09.2026): every live «до сброса» add-on
 * now ends at the FIRST reset under the new rule, but never later than the
 * date it was promised. Remnawave runs the new rule's job from the moment it
 * receives the strategy, and the old rule's reset will not come for this
 * profile, so an end left at the old reset could outlive a reset that does.
 *
 *  - NO_RESET: every add-on keeps its date — there is no reset to end at.
 *  - A rolling rule without an anchor (the profile's `createdAt` not known
 *    yet), or a zone the runtime does not know: no first reset can be
 *    computed, so the dates stand; the promised date still caps them.
 *  - An add-on moved earlier is bound to the new rule's epoch on its OWN term
 *    (the `(expiry_epoch_id, term_id)` key), so it reads as reset-bound, and
 *    the move is written as an event, as the tail alignment writes its moves.
 *
 * Safe to call when the rule did not change: the first reset under the same
 * rule is never earlier than the one an add-on of the current cycle was sold
 * until, so nothing moves. Returns the ids of the add-ons it moved.
 */
export async function redateResetAddOnsInTransaction(
  tx: Prisma.TransactionClient,
  input: RedateResetAddOnsInput,
): Promise<readonly string[]> {
  if (input.strategy === 'NO_RESET') return [];
  let plan: ReturnType<typeof planResetEpoch>;
  try {
    // The anchor matters for MONTH_ROLLING alone; calendar strategies take
    // any date, so `now` stands in for a missing one.
    const anchorAt = input.strategy === 'MONTH_ROLLING' ? input.anchorAt : (input.anchorAt ?? input.now);
    if (anchorAt === null) return [];
    plan = planResetEpoch({
      strategy: input.strategy,
      capability: 'ENABLED',
      anchorAt,
      referenceAt: input.now,
      timeZone: input.timeZone,
    });
  } catch {
    return [];
  }
  if (plan === null) return [];
  const newEnd = plan.expiresAt;

  const moved = await tx.addOnEntitlement.findMany({
    where: {
      subscriptionId: input.subscriptionId,
      lifetime: AddOnLifetime.UNTIL_NEXT_RESET,
      state: { in: [AddOnEntitlementState.PENDING_ACTIVATION, AddOnEntitlementState.ACTIVE] },
      expiresAt: { gt: newEnd },
    },
    orderBy: { id: 'asc' },
    select: { id: true, state: true, version: true, termId: true, expiresAt: true, expiryEpochId: true },
  });
  const redated: string[] = [];
  for (const entitlement of moved) {
    const epoch = await bindResetEpochWindow(tx, {
      termId: entitlement.termId,
      startsAt: plan.startsAt,
      plannedEndsAt: plan.plannedEndsAt,
    });
    const claimed = await tx.addOnEntitlement.updateMany({
      where: { id: entitlement.id, state: entitlement.state, version: entitlement.version },
      data: { expiresAt: newEnd, expiryEpochId: epoch.id, version: { increment: 1 } },
    });
    // A transition that won the row (the boundary sweep expiring it) owns it
    // now; there is nothing left here to move.
    if (claimed.count !== 1) continue;
    await tx.addOnEntitlementEvent.create({
      data: {
        entitlementId: entitlement.id,
        fromState: entitlement.state,
        toState: entitlement.state,
        reason: input.reason,
        actorType: AddOnEntitlementActorType.SYSTEM,
        correlationId: input.correlationId,
        // The version the move produced: unique per add-on by construction.
        commandKey: `reset-rule:v${entitlement.version + 1}`,
        metadata: {
          strategy: input.strategy,
          previousExpiresAt: entitlement.expiresAt?.toISOString() ?? null,
          expiresAt: newEnd.toISOString(),
          previousExpiryEpochId: entitlement.expiryEpochId,
          expiryEpochId: epoch.id,
        },
      },
    });
    redated.push(entitlement.id);
  }
  return redated;
}

async function findByWindow(
  tx: Prisma.TransactionClient,
  termId: string,
  plannedEndsAt: Date,
): Promise<LiveResetEpoch | null> {
  return tx.subscriptionResetEpoch.findUnique({
    where: { termId_plannedEndsAt: { termId, plannedEndsAt } },
    select: { id: true, startsAt: true, plannedEndsAt: true },
  });
}
