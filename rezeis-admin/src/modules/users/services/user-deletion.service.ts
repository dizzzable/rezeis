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
          `deleteUser: subscription ${subscription.id} was snapshotted with no Remnawave id; ` +
            'any panel profile it still had is now unreachable from rezeis',
        );
        continue;
      }
      try {
        await this.remnawaveApiService.deletePanelUser(identity);
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

            const profileSnapshots = await tx.subscription.findMany({
              where: { userId, remnawaveId: { not: null } },
              select: {
                id: true,
                remnawaveId: true,
                remnawavePanelId: true,
                remnawavePanelUsername: true,
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
