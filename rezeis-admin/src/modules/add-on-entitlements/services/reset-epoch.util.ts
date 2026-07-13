import { Prisma } from '@prisma/client';

import { planResetEpoch, ResetCapability, ResetStrategy } from '../domain/reset-cycle-policy';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** The minimal live-epoch shape callers need to bind an entitlement's expiry. */
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
 * The window is computed purely from `planResetEpoch(strategy, anchorAt, now)`,
 * so eligibility (which quotes the same computation on the fly) and the money
 * path (which binds to a PERSISTED epoch) always agree — the offered
 * `expiresAt` is always honored (no silent legacy fallback for a missing row).
 *
 * Returns `null` (caller falls back to the legacy path) when there is no
 * commercial reset window: `NO_RESET`, capability not `ENABLED`, a null anchor,
 * or a strategy/anchor that yields no epoch.
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

  const plan = planResetEpoch({
    strategy: input.strategy,
    capability: 'ENABLED',
    anchorAt: input.anchorAt,
    referenceAt: input.now,
  });
  if (plan === null) return null;

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
