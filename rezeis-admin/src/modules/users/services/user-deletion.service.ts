import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { AddOnEntitlementService } from '../../add-on-entitlements/services/add-on-entitlement.service';
import {
  describeDurableRows,
  discardDisposableRowsInTransaction,
} from '../../add-on-entitlements/services/cutover-disposal.util';
import {
  DurableRetirementServices,
  retireDurableRowsInTransaction,
} from '../../add-on-entitlements/services/durable-retirement.util';
import { SubscriptionTermService } from '../../add-on-entitlements/services/subscription-term.service';
import { storedIdentityOf } from '../../remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import {
  assessObservedPanelLink,
  observePanelEra,
  SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE,
} from '../../remnawave/services/stale-panel-link';

export const USER_DELETE_PROTECTED_HISTORY_CODE = 'USER_DELETE_PROTECTED_HISTORY';
export const USER_DELETE_PROTECTED_HISTORY_MESSAGE =
  'This user has protected payment, partner-ledger, or reward history and cannot be permanently deleted. Block the account instead, or delete in full — the money history is kept on an anonymous holder.';

const MAX_TRANSACTION_ATTEMPTS = 3;

/**
 * Which of the two deletions the operator asked for.
 *
 * `protected` is the one that has always existed: it deletes an account that
 * owes the books nothing and refuses outright otherwise.
 *
 * `full` is what «Удалить полностью» does. The account and everything about it
 * go; the protected rows are MOVED onto a fresh row carrying no identity, so
 * revenue already reported for a closed month is not silently rewritten. See
 * `anonymized-user.util.ts` for what such a row is and where it must not be
 * counted.
 */
export type UserDeletionMode = 'protected' | 'full';

/** What a full deletion kept, and what it destroyed. Written to the audit row. */
export interface UserDeletionSummary {
  readonly mode: UserDeletionMode;
  /** The holder that now owns the money history; `null` for a plain deletion. */
  readonly holderUserId: string | null;
  readonly preserved: ProtectedHistoryCounts;
  /** Sum of every transaction moved, per currency — the operator reads this. */
  readonly preservedTotals: ReadonlyArray<{ readonly currency: string; readonly amount: string }>;
  /** Destroyed outright, on the owner's decision of 21.09.2026. */
  readonly purged: { readonly trialClaims: number };
}

/**
 * What stands between this account and an ordinary deletion.
 *
 * Counted and REPORTED rather than collapsed into one refusal: «нельзя» with
 * no subject is why the operator could not tell a test account that took a
 * free trial from one that took real money, and both were equally
 * undeletable.
 */
export interface ProtectedHistoryCounts {
  readonly transactions: number;
  readonly promocodeActivations: number;
  readonly referralPointsExchanges: number;
  readonly referralRewards: number;
  readonly partnerTransactions: number;
  readonly partnerWithdrawals: number;
  readonly trialClaims: number;
}

/**
 * The add-on model's records of money on the account's subscriptions, which an
 * ORDINARY deletion cannot take with them (`describeDurableRows`): summed per
 * kind over the subscriptions that hold any. Named in the refusal beside the
 * counters above — a refusal that named nothing left the operator guessing, as
 * the merge of duplicates never did. «Удалить полностью» retires them instead.
 */
export interface DurableHistoryCounts {
  readonly addOnPurchases: number;
  readonly paidTerms: number;
  readonly resetPeriods: number;
  readonly deviceReductions: number;
  readonly openIncidents: number;
}

/** What a refused ordinary deletion names. */
export type DeleteBlockers = ProtectedHistoryCounts & Partial<DurableHistoryCounts>;

function totalProtected(counts: ProtectedHistoryCounts): number {
  return (
    counts.transactions +
    counts.promocodeActivations +
    counts.referralPointsExchanges +
    counts.referralRewards +
    counts.partnerTransactions +
    counts.partnerWithdrawals +
    counts.trialClaims
  );
}

interface RemnawaveProfileSnapshot {
  readonly id: string;
  readonly remnawaveId: string | null;
  /**
   * The two supplementary identity columns, snapshotted inside the same
   * transaction as `remnawaveId`. They cannot be re-read afterwards: the user
   * row (and with it every subscription) is gone by the time the panel is
   * called.
   */
  readonly remnawavePanelId: number | null;
  readonly remnawavePanelUsername: string | null;
}

/**
 * Owns the destructive boundary for admin-driven user deletion.
 *
 * Financial, promocode, and referral-reward rows are deliberately protected
 * by `onDelete: Restrict` in the Prisma schema. This service keeps that
 * invariant intact: it never deletes audit rows to make a user deletion pass.
 *
 * Database deletion commits before the best-effort Remnawave cleanup. That
 * ordering is important: a protected-history conflict must not remove the
 * user's live panel profile while leaving the local account in place.
 */
@Injectable()
export class UserDeletionService {
  private readonly logger = new Logger(UserDeletionService.name);

  /**
   * The two term-model services come from `AddOnEntitlementsModule`, which
   * `UsersModule` imports. Required, not optional: a module that provided this
   * service without them should fail at boot, not retire durable rows through
   * a private copy nobody wired.
   */
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly addOnEntitlementService: AddOnEntitlementService,
    private readonly subscriptionTermService: SubscriptionTermService,
  ) {}

  public async deleteUser(
    userId: string,
    options: { readonly mode?: UserDeletionMode } = {},
  ): Promise<UserDeletionSummary> {
    const mode = options.mode ?? 'protected';
    const { profileSnapshots, summary } = await this.deleteDatabaseUser(userId, mode);

    for (const subscription of profileSnapshots) {
      const identity = storedIdentityOf(subscription);
      if (identity === null) {
        // Genuinely nothing to delete — but no longer silently. The local rows
        // are already committed away, so if a profile does exist upstream it
        // now belongs to no user, no sweep will ever look for it again, and
        // this log line is the only trace an operator will ever get.
        this.logger.warn(
          `deleteUser: subscription ${subscription.id} was snapshotted with no Remnawave id ` +
            `(panel username '${subscription.remnawavePanelUsername ?? 'none'}'); ` +
            'any panel profile it still had is now unreachable from rezeis',
        );
        continue;
      }
      // ── THE STALE-LINK REFUSAL, ON THE ONE PATH THAT MUST NEVER BLOCK ──────
      //
      // THE CUSTOMER IS ALREADY DELETED. `deleteDatabaseUser` committed above,
      // by design — a protected-history conflict must not remove a live panel
      // profile while leaving the account behind — so by the time this loop
      // runs there is no local deletion left to refuse and nothing here can
      // make deleting a customer impossible. What IS still refusable is the
      // upstream call, and it is refused for exactly the reason
      // `SubscriptionDeletionService` refuses the operator's: on a 3.x panel a
      // uuid-shaped identity does not name the profile it was written for, and
      // `panelUserAddress` resolves it through the stored subscription link to
      // whatever profile is live at that address — on an unmerged duplicate
      // pair, somebody else's.
      //
      // SKIPPING LEAVES AN ORPHAN, AND THAT IS THE CHEAPER LOSS. An unbilled
      // profile keeps serving until an operator removes it by hand, which the
      // line below tells them to do, by name. Deleting on a guess removes a
      // paying customer's service and cannot be undone at all.
      //
      // ONE OBSERVATION OF THE PANEL ERA, TAKEN HERE AND USED TWICE — by the
      // refusal below and by the address `deletePanelUser` builds. Two
      // independent `getPanelShape()` reads could disagree across the
      // fifteen-second negative cache boundary and let a "proceed" decided on
      // `'unknown'` be carried out against `'id'`, which is the reading that
      // resolves this dead uuid to somebody else's live account.
      const era = await observePanelEra(() => this.remnawaveApiService.getPanelShape());
      const trust = assessObservedPanelLink(era, identity.remnawaveId);
      if (!trust.trusted) {
        this.logger.error(
          `deleteUser: ${SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE} — subscription ` +
            `${subscription.id} stores the 2.x identity '${subscription.remnawaveId ?? 'none'}' ` +
            'and the panel is 3.x, so it no longer names the profile it was written for. The ' +
            'user has been deleted locally and the panel deletion was SKIPPED: the profile ' +
            `'${subscription.remnawavePanelUsername ?? 'unknown'}' is still live and must be ` +
            'removed by hand.',
        );
        continue;
      }
      try {
        await this.remnawaveApiService.deletePanelUser(identity, era);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.warn(
          `deleteUser: failed to delete panel profile ${subscription.remnawaveId} for subscription ${subscription.id}: ${message}`,
        );
      }
    }
    return summary;
  }

  private async deleteDatabaseUser(
    userId: string,
    mode: UserDeletionMode,
  ): Promise<{
    readonly profileSnapshots: readonly RemnawaveProfileSnapshot[];
    readonly summary: UserDeletionSummary;
  }> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prismaService.$transaction(
          async (tx) => {
            const counts = await countProtectedHistory(tx, userId);

            if (mode === 'full') {
              // SNAPSHOT FIRST. The move below hands the subscriptions to the
              // holder and clears their panel identity, so a snapshot taken
              // after it finds nothing at all under `userId` — and the customer
              // would be deleted here while their profile kept serving VPN
              // upstream, addressed by nobody and billed to no one.
              const profileSnapshots = await snapshotPanelProfiles(tx, userId);
              // Counted INSIDE this transaction and at Serializable, so the
              // summary the operator is shown afterwards describes what was
              // actually moved rather than what a read a moment earlier saw.
              const summary = await moveProtectedHistoryToHolder(tx, userId, counts, {
                entitlements: this.addOnEntitlementService,
                terms: this.subscriptionTermService,
              });
              await tx.user.delete({ where: { id: userId } });
              return { profileSnapshots, summary };
            }

            if (totalProtected(counts) > 0) {
              throw protectedHistoryConflict(counts);
            }

            const profileSnapshots = await snapshotPanelProfiles(tx, userId);

            // THE MODEL'S OWN ROWS ARE NOT HISTORY. The background cutover
            // gives every live subscription a first term and a projection,
            // minted from its own columns, and both are `Restrict` on it — so
            // without this, the cascade below hit the foreign key for every
            // account that has a subscription at all, and the operator was
            // told "protected history" about an account with none. Rows that
            // record no money — those, the terms a plan change rotated them
            // onto, closed incidents — go with the subscription. Money (an
            // add-on, a paid term, a reset period, a device plan, an open
            // incident) refuses, and the refusal NAMES it: it used to reach the
            // cascade's foreign key and come back as an unnamed conflict.
            const kept = await discardDisposableRowsOfUser(tx, userId);
            if (kept !== null) {
              throw protectedHistoryConflict({ ...counts, ...kept });
            }

            await tx.user.delete({ where: { id: userId } });
            return {
              profileSnapshots,
              summary: {
                mode,
                holderUserId: null,
                preserved: counts,
                preservedTotals: [],
                purged: { trialClaims: 0 },
              } satisfies UserDeletionSummary,
            };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );
      } catch (error: unknown) {
        if (isPrismaKnownError(error, 'P2034') && attempt < MAX_TRANSACTION_ATTEMPTS) {
          continue;
        }
        if (isPrismaKnownError(error, 'P2003')) {
          throw protectedHistoryConflict();
        }
        if (isPrismaKnownError(error, 'P2025')) {
          throw new NotFoundException('User not found');
        }
        throw error;
      }
    }

    // The retry loop either returns or throws. This keeps the return type
    // exhaustive if the attempt bound changes later.
    throw new Error('User deletion transaction retry limit exhausted');
  }
}

function protectedHistoryConflict(blockedBy?: DeleteBlockers): ConflictException {
  return new ConflictException({
    code: USER_DELETE_PROTECTED_HISTORY_CODE,
    message: USER_DELETE_PROTECTED_HISTORY_MESSAGE,
    // NAMED, not just refused. «Нельзя» with no subject is why an operator
    // could not tell a test account that took a free trial from one that took
    // real money — both were equally undeletable and neither said why. The SPA
    // prints these, and they are what the second confirmation is about.
    ...(blockedBy === undefined ? {} : { blockedBy }),
  });
}

/**
 * The seven things that stand between an account and an ordinary deletion.
 *
 * Four are enforced by the database (`onDelete: Restrict` on `Transaction`,
 * `PromocodeActivation`, `ReferralReward` and `TrialClaim`); the partner ones
 * are policy here, because the ledger they belong to is the operator's rather
 * than the customer's. Counted together so the refusal can say which.
 */
async function countProtectedHistory(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<ProtectedHistoryCounts> {
  const [
    transactions,
    promocodeActivations,
    referralPointsExchanges,
    referralRewards,
    partnerTransactions,
    partnerWithdrawals,
    trialClaims,
  ] = await Promise.all([
    tx.transaction.count({ where: { userId } }),
    tx.promocodeActivation.count({ where: { userId } }),
    tx.referralPointsExchange.count({ where: { userId } }),
    tx.referralReward.count({ where: { userId } }),
    tx.partnerTransaction.count({
      where: { OR: [{ referralUserId: userId }, { partner: { userId } }] },
    }),
    tx.partnerWithdrawal.count({ where: { partner: { userId } } }),
    tx.trialClaim.count({ where: { userId } }),
  ]);
  return {
    transactions,
    promocodeActivations,
    referralPointsExchanges,
    referralRewards,
    partnerTransactions,
    partnerWithdrawals,
    trialClaims,
  };
}

/**
 * THE HALF OF A FULL DELETION THAT IS NOT A DELETION.
 *
 * A payment that happened happened. Dropping the rows would silently rewrite
 * the revenue already reported for a month that is closed — so they are moved
 * onto a fresh row that is not a person: no Telegram id, no e-mail, no login,
 * no name, blocked, and marked `anonymizedAt`.
 *
 * Three things travel with them, and each is a report that would otherwise
 * move on its own: `createdAt` (cohorts), the acquisition triple (per-placement
 * payback) and `registrationChannel`. None of them names anybody.
 *
 * SUBSCRIPTIONS MOVE TOO, and that is not an oversight. `TransactionItem`
 * points at the subscription a line paid for with `onDelete: Restrict`, so a
 * kept payment forbids deleting what it bought; and this product never hard-
 * deletes a subscription anyway — the operator's own «удалить подписку» marks
 * it `DELETED` and removes the panel profile. Moving them keeps both rules.
 * Their panel identity is cleared here, AFTER the caller snapshotted it, so no
 * sweep re-addresses a profile that is about to be removed upstream.
 *
 * The trial ledger is the one thing destroyed outright, on the owner's
 * decision of 21.09.2026: a test account that took the free trial could never
 * be cleared, which is the whole reason this path exists.
 *
 * AND THE TERM MODEL IS TOLD, before the subscriptions turn DELETED: each one's
 * live add-ons are reversed, its terms closed, its projection marked DELETED
 * and its open device plans superseded — what the operator's own «удалить
 * подписку» does (`SubscriptionDeletionService`), through the same
 * `retireDurableRowsInTransaction`. Marking the rows DELETED with a bulk update
 * and nothing else left an ACTIVE add-on on a DELETED row: the boundary sweep
 * picked it at its end, the projection recompute refused the DELETED row, and
 * the whole boundary transaction rolled back — on every tick, for good.
 */
async function moveProtectedHistoryToHolder(
  tx: Prisma.TransactionClient,
  userId: string,
  counts: ProtectedHistoryCounts,
  durable: DurableRetirementServices,
): Promise<UserDeletionSummary> {
  const original = await tx.user.findUnique({
    where: { id: userId },
    select: {
      createdAt: true,
      language: true,
      acquisitionPlacementId: true,
      acquisitionAt: true,
      acquisitionWindowDays: true,
      registrationChannel: true,
    },
  });
  if (original === null) {
    throw new NotFoundException('User not found');
  }

  const totals = await tx.transaction.groupBy({
    by: ['currency'],
    where: { userId },
    _sum: { amount: true },
  });

  // A HOLDER ONLY WHEN THERE IS SOMETHING TO HOLD. Most accounts a full
  // deletion is asked for — the test ones this path exists for — owe the books
  // nothing at all, and a holder per deletion would grow `users` by a blank
  // row every time for no reason. Subscriptions count here too: they are what
  // a kept payment's `TransactionItem` points at, and their own terms forbid
  // deleting them.
  const subscriptions = await tx.subscription.count({ where: { userId } });
  const needsHolder =
    subscriptions > 0 ||
    counts.transactions > 0 ||
    counts.promocodeActivations > 0 ||
    counts.referralPointsExchanges > 0 ||
    counts.referralRewards > 0 ||
    counts.partnerTransactions > 0 ||
    counts.partnerWithdrawals > 0;

  if (!needsHolder) {
    const purgedOnly = await tx.trialClaim.deleteMany({ where: { userId } });
    return {
      mode: 'full',
      holderUserId: null,
      preserved: counts,
      preservedTotals: [],
      purged: { trialClaims: purgedOnly.count },
    };
  }

  const holder = await tx.user.create({
    data: {
      name: '',
      anonymizedAt: new Date(),
      // Blocked as well as anonymous: nothing about this row may ever be read
      // as an account somebody could act through.
      isBlocked: true,
      createdAt: original.createdAt,
      language: original.language,
      acquisitionPlacementId: original.acquisitionPlacementId,
      acquisitionAt: original.acquisitionAt,
      acquisitionWindowDays: original.acquisitionWindowDays,
      registrationChannel: original.registrationChannel,
    },
    select: { id: true },
  });

  await tx.transaction.updateMany({ where: { userId }, data: { userId: holder.id } });
  await tx.promocodeActivation.updateMany({ where: { userId }, data: { userId: holder.id } });
  await tx.referralReward.updateMany({ where: { userId }, data: { userId: holder.id } });
  await tx.referralPointsExchange.updateMany({ where: { userId }, data: { userId: holder.id } });
  await tx.partnerTransaction.updateMany({
    where: { referralUserId: userId },
    data: { referralUserId: holder.id },
  });
  // The partner row carries the ledger and the withdrawals (`PartnerWithdrawal`
  // is `Restrict` on it), so it moves rather than cascading away — deactivated,
  // because a holder must never accrue or be paid.
  await tx.partner.updateMany({
    where: { userId },
    data: { userId: holder.id, isActive: false },
  });
  // Row locks first, in id order: the lock every durable writer — the boundary
  // sweep, a payment — takes before it touches a term or an add-on, so this
  // deletion queues behind one in flight instead of deadlocking with it (a
  // deadlock surfaces as P2039/P2010, which the retry below does not catch).
  const owned = await tx.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "subscriptions"
    WHERE "user_id" = ${userId}
    ORDER BY "id"
    FOR UPDATE
  `);
  for (const { id } of owned) {
    await retireDurableRowsInTransaction(tx, durable, {
      subscriptionId: id,
      correlationId: `user-delete:${userId}`,
      reason: 'USER_DELETED',
    });
  }
  await tx.subscription.updateMany({
    where: { userId },
    data: {
      userId: holder.id,
      status: SubscriptionStatus.DELETED,
      remnawaveId: null,
      remnawavePanelId: null,
      remnawavePanelUsername: null,
    },
  });

  const purgedTrialClaims = await tx.trialClaim.deleteMany({ where: { userId } });

  return {
    mode: 'full',
    holderUserId: holder.id,
    preserved: counts,
    preservedTotals: totals.map((row) => ({
      currency: String(row.currency),
      amount: (row._sum.amount ?? new Prisma.Decimal(0)).toString(),
    })),
    purged: { trialClaims: purgedTrialClaims.count },
  };
}

/**
 * Deletes the durable rows that record no money of each of the account's
 * subscriptions (see `discardDisposableRowsInTransaction`), under their row
 * locks, taken in id order like every other writer here.
 *
 * Returns `null` when every subscription's rows went, or else what the others
 * hold, summed per kind — the caller refuses with it, and its transaction then
 * rolls back whatever this did discard.
 */
async function discardDisposableRowsOfUser(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<DurableHistoryCounts | null> {
  const owned = await tx.$queryRaw<Array<{ readonly id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "subscriptions"
    WHERE "user_id" = ${userId}
    ORDER BY "id"
    FOR UPDATE
  `);
  const kept = { addOnPurchases: 0, paidTerms: 0, resetPeriods: 0, deviceReductions: 0, openIncidents: 0 };
  let refused = false;
  for (const { id } of owned) {
    if ((await discardDisposableRowsInTransaction(tx, id)) !== null) continue;
    refused = true;
    const held = await describeDurableRows(tx, id);
    kept.addOnPurchases += held.entitlements;
    kept.paidTerms += held.paidTerms;
    kept.resetPeriods += held.resetEpochs;
    kept.deviceReductions += held.devicePlans;
    kept.openIncidents += held.openIncidents;
  }
  return refused ? kept : null;
}

/**
 * Every panel profile this account still has a trace of, taken inside the
 * transaction that removes it.
 *
 * ASKED AS "does this row carry ANY trace of a panel profile", not as "does it
 * carry an id". `remnawaveId: { not: null }` alone made the null-identity warn
 * in `deleteUser` UNREACHABLE — a row it would fire for could never enter the
 * snapshot — and the rows it excluded are exactly the ones the warn exists for.
 *
 * Those rows are real and they are the expensive case. The create/update
 * decoder used to CAST an undecoded panel body into `RemnawavePanelUser`; on
 * 3.x that produced `uuid === undefined` and `panelId === undefined`, both of
 * which Prisma reads as "leave the column alone", while
 * `remnawavePanelUsername` and `configUrl` came from arguments and DID land. So
 * a live panel profile can be owned by a row whose only surviving evidence of
 * it is those two columns — see `PanelLinkReconciliationService`, which selects
 * on exactly that signature.
 *
 * Deleting such a user with the narrow filter destroyed the local rows and left
 * the panel profile running with nothing pointing at it: no sweep looks for it,
 * the reconciliation repair can no longer find it (its row is gone), and nobody
 * is billed for it. Widening does not make it deletable — there is still no id
 * to address — but it makes the loss VISIBLE at the one moment an operator can
 * still act on it.
 */
async function snapshotPanelProfiles(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<readonly RemnawaveProfileSnapshot[]> {
  return tx.subscription.findMany({
    where: {
      userId,
      OR: [
        { remnawaveId: { not: null } },
        { remnawavePanelId: { not: null } },
        { remnawavePanelUsername: { not: null } },
      ],
    },
    select: {
      id: true,
      remnawaveId: true,
      remnawavePanelId: true,
      remnawavePanelUsername: true,
      configUrl: true,
    },
  });
}

function isPrismaKnownError(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  return candidate.name === 'PrismaClientKnownRequestError' && candidate.code === code;
}
