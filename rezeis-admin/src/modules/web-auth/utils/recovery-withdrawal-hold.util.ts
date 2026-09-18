import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * The withdrawal hold after a password reset by subscription link.
 * ═════════════════════════════════════════════════════════════════
 * Recovery by subscription link is open only to an account with no Telegram
 * and no verified e-mail, and for such an account the link is effectively the
 * whole proof: the login typed beside it is not a secret (Remnawave profiles
 * are named after it). A subscription link is not a secret the way a password
 * is either — customers share it with family, paste it into apps, post it in
 * support chats. The one thing somebody holding a shared link could turn into
 * money is a partner balance, so for three days after such a reset nothing
 * leaves it: neither a withdrawal request nor a purchase paid with the balance
 * (see `assertPartnerBalanceNotHeld`).
 *
 * ── Why a row in `auth_challenges` ────────────────────────────────────────
 *
 * The hold has to be DURABLE: a Redis key disappears on a flush, a restart
 * without persistence or an eviction, and a hold that can evaporate is exactly
 * the hold an impostor waits out. The two durable alternatives both lose:
 *   - a column on `web_accounts`/`partners` is a migration, for one timestamp;
 *   - the audit-log row of `auth.password_recovery` is written fire-and-forget
 *     AFTER the reset, so a failed write would silently leave no hold.
 * `auth_challenges` already models "a time-limited security state of this web
 * account" (email codes, link codes), has a `(web_account_id, purpose)` index,
 * cascades with the account, and — decisively — the row is written in the SAME
 * transaction as the new password hash: no hold, no reset. No other flow
 * touches this purpose; they all revoke rows by their own purpose only.
 */
export const RECOVERY_WITHDRAWAL_HOLD_PURPOSE = 'recovery_withdrawal_hold';

/** The channel recorded on the hold row: how the password was recovered. */
export const RECOVERY_WITHDRAWAL_HOLD_CHANNEL = 'subscription_link';

/** How long partner withdrawals wait after a reset by subscription link. */
export const RECOVERY_WITHDRAWAL_HOLD_HOURS = 72;

/**
 * The refusal code of EVERY path that moves partner money while a hold stands
 * — a withdrawal request and paying with the partner balance alike. The name
 * predates the second path; it is a wire contract now, so it stays.
 */
export const WITHDRAWAL_HOLD_ERROR_CODE = 'WITHDRAWAL_HOLD_AFTER_RECOVERY';

/** The only read the hold check makes. `PrismaService` satisfies it. */
export interface RecoveryWithdrawalHoldReader {
  readonly authChallenge: {
    findFirst(args: {
      where: Prisma.AuthChallengeWhereInput;
      orderBy: { expiresAt: 'desc' };
      select: { expiresAt: true };
    }): PromiseLike<{ expiresAt: Date } | null>;
  };
}

/**
 * When the hold on this user's withdrawals ends, or `null` when there is none.
 * The latest-ending live hold wins, so two resets in a row hold for three days
 * from the second.
 */
export async function findRecoveryWithdrawalHold(
  db: RecoveryWithdrawalHoldReader,
  userId: string,
  now: Date,
): Promise<Date | null> {
  const hold = await db.authChallenge.findFirst({
    where: {
      purpose: RECOVERY_WITHDRAWAL_HOLD_PURPOSE,
      consumedAt: null,
      expiresAt: { gt: now },
      webAccount: { userId },
    },
    orderBy: { expiresAt: 'desc' },
    select: { expiresAt: true },
  });
  return hold?.expiresAt ?? null;
}

/**
 * The refusal while a hold stands: a 400, like the partner service's own
 * refusals ("Insufficient partner balance"), carrying the code and the end of
 * the hold. `AdminSafeExceptionFilter` forwards both — the code is on its
 * product allowlist and `holdUntil` on the field allowlist for this code only —
 * and the message on its own, which is why it does not name the password: that
 * word is one of the filter's sensitive patterns, and a message with it in
 * reaches the cabinet as "Request failed".
 */
export function recoveryHoldRefusal(holdUntil: Date): BadRequestException {
  const until = holdUntil.toISOString();
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: `The partner balance is on hold until ${until} after an account recovery`,
    code: WITHDRAWAL_HOLD_ERROR_CODE,
    holdUntil: until,
  });
}

/**
 * THE check every path that takes money out of a partner balance runs before
 * its debit — `PartnersService.createWithdrawalRequest` and
 * `PartnerBalancePaymentService.pay`. `test/partner-balance-recovery-hold.spec.ts`
 * inventories the debits in `src/` and fails on one that is neither of these
 * nor classified as system-initiated.
 */
export async function assertPartnerBalanceNotHeld(
  db: RecoveryWithdrawalHoldReader,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const holdUntil = await findRecoveryWithdrawalHold(db, userId, now);
  if (holdUntil !== null) throw recoveryHoldRefusal(holdUntil);
}
