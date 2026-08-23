import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { storedIdentityOf } from '../../remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import {
  assessObservedPanelLink,
  observePanelEra,
  SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE,
} from '../../remnawave/services/stale-panel-link';

export const USER_DELETE_PROTECTED_HISTORY_CODE = 'USER_DELETE_PROTECTED_HISTORY';
export const USER_DELETE_PROTECTED_HISTORY_MESSAGE =
  'This user has protected payment, partner-ledger, or reward history and cannot be permanently deleted. Block the account instead; audit records must be preserved.';

const MAX_TRANSACTION_ATTEMPTS = 3;

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

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  public async deleteUser(userId: string): Promise<void> {
    const profileSnapshots = await this.deleteDatabaseUser(userId);

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
  }

  private async deleteDatabaseUser(userId: string): Promise<readonly RemnawaveProfileSnapshot[]> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prismaService.$transaction(
          async (tx) => {
            const transactionCount = await tx.transaction.count({ where: { userId } });
            const promocodeActivationCount = await tx.promocodeActivation.count({ where: { userId } });
            const referralPointsExchangeCount = await tx.referralPointsExchange.count({ where: { userId } });
            const referralRewardCount = await tx.referralReward.count({ where: { userId } });
            const partnerTransactionCount = await tx.partnerTransaction.count({
              where: {
                OR: [
                  { referralUserId: userId },
                  { partner: { userId } },
                ],
              },
            });
            const partnerWithdrawalCount = await tx.partnerWithdrawal.count({
              where: { partner: { userId } },
            });
            const trialClaimCount = await tx.trialClaim.count({ where: { userId } });

            if (
              transactionCount > 0 ||
              promocodeActivationCount > 0 ||
              referralPointsExchangeCount > 0 ||
              referralRewardCount > 0 ||
              partnerTransactionCount > 0 ||
              partnerWithdrawalCount > 0 ||
              trialClaimCount > 0
            ) {
              throw protectedHistoryConflict();
            }

            // ASKED AS "does this row carry ANY trace of a panel profile", not
            // as "does it carry an id". `remnawaveId: { not: null }` alone made
            // the null-identity warn below UNREACHABLE — a row it would fire
            // for could never enter the snapshot — and the rows it excluded are
            // exactly the ones the warn exists for.
            //
            // Those rows are real and they are the expensive case. The
            // create/update decoder used to CAST an undecoded panel body into
            // `RemnawavePanelUser`; on 3.x that produced `uuid === undefined`
            // and `panelId === undefined`, both of which Prisma reads as "leave
            // the column alone", while `remnawavePanelUsername` and `configUrl`
            // came from arguments and DID land. So a live panel profile can be
            // owned by a row whose only surviving evidence of it is those two
            // columns — see `PanelLinkReconciliationService`, which selects on
            // exactly that signature.
            //
            // Deleting such a user with the narrow filter destroyed the local
            // rows and left the panel profile running with nothing pointing at
            // it: no sweep looks for it, the reconciliation repair can no
            // longer find it (its row is gone), and nobody is billed for it.
            // Widening does not make it deletable — there is still no id to
            // address — but it makes the loss VISIBLE at the one moment an
            // operator can still act on it.
            const profileSnapshots = await tx.subscription.findMany({
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

            await tx.user.delete({ where: { id: userId } });
            return profileSnapshots;
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

function protectedHistoryConflict(): ConflictException {
  return new ConflictException({
    code: USER_DELETE_PROTECTED_HISTORY_CODE,
    message: USER_DELETE_PROTECTED_HISTORY_MESSAGE,
  });
}

function isPrismaKnownError(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  return candidate.name === 'PrismaClientKnownRequestError' && candidate.code === code;
}
