import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PasswordHashService } from '../../auth/services/password-hash.service';
import type {
  WebFirstPasswordResultInterface,
  WebPasswordStateResultInterface,
} from '../interfaces/web-auth.interface';
import { raiseSessionsRevokedAt, type SessionsRevokedAtWriter } from '../utils/sessions-revoked-at.util';

/**
 * A first password, set from a session the customer already has
 * ══════════════════════════════════════════════════════════════
 * An account imported without a password (`passwordBootstrapPending`) may be
 * signed in to already — through the Telegram Mini App, which needs no
 * password. The cabinet then sends it to «Смена пароля», which asks for the
 * current password, and there is none: the only way out was a reset link.
 * Here the signed-in customer sets the first one directly.
 *
 * WHAT MAKES THIS SAFE:
 *   - it writes only where no password exists — the check below AND the
 *     `passwordHash: null` in the `where` of the write itself, so a password set
 *     a moment earlier by anyone (a concurrent request, a reset link) is never
 *     overwritten: the write matches nothing and the answer is `has_password`;
 *   - the account is the one of the cabinet's own server session — the cabinet
 *     sends `userId` from its session, never from the browser;
 *   - like any new password it signs every older session out
 *     (`sessionsRevokedAt`), in the same transaction, with a moment taken once
 *     the password is hashed and a statement that never moves it back
 *     (`sessions-revoked-at.util.ts`).
 *
 * It clears `passwordBootstrapPending` and `requiresPasswordChange`, which are
 * what sent the customer to the password page, so the cabinet lets them in.
 */

export const FIRST_PASSWORD_ACCOUNT_SELECT = {
  id: true,
  login: true,
  passwordHash: true,
  credentialsBootstrappedAt: true,
  user: { select: { isBlocked: true } },
} as const satisfies Prisma.WebAccountSelect;

export type FirstPasswordAccountRow = Prisma.WebAccountGetPayload<{
  select: typeof FIRST_PASSWORD_ACCOUNT_SELECT;
}>;

/** What the write needs of a transaction: the password, then the sign-out moment. */
export interface WebFirstPasswordTransaction extends SessionsRevokedAtWriter {
  readonly webAccount: {
    updateMany(args: {
      where: Prisma.WebAccountWhereInput;
      data: Prisma.WebAccountUpdateManyMutationInput;
    }): PromiseLike<Prisma.BatchPayload>;
  };
}

export interface WebFirstPasswordDatabase {
  readonly webAccount: {
    findUnique(args: {
      where: Prisma.WebAccountWhereUniqueInput;
      select: typeof FIRST_PASSWORD_ACCOUNT_SELECT;
    }): PromiseLike<FirstPasswordAccountRow | null>;
  };
  $transaction<R>(fn: (tx: WebFirstPasswordTransaction) => Promise<R>): Promise<R>;
}

/** DI token for the database port. */
export const WEB_FIRST_PASSWORD_DATABASE = Symbol('WEB_FIRST_PASSWORD_DATABASE');

/** The real client, typed as the port — this line is the compile-time proof it fits. */
export function asWebFirstPasswordDatabase(prisma: PrismaService): WebFirstPasswordDatabase {
  return prisma;
}

export type FirstPasswordHasher = Pick<PasswordHashService, 'hashPassword'>;

@Injectable()
export class WebFirstPasswordService {
  private readonly logger = new Logger(WebFirstPasswordService.name);

  public constructor(
    @Inject(WEB_FIRST_PASSWORD_DATABASE) private readonly db: WebFirstPasswordDatabase,
    @Inject(PasswordHashService) private readonly hasher: FirstPasswordHasher,
  ) {}

  /** Whether the signed-in customer's account has a password yet. */
  public async state(userId: string): Promise<WebPasswordStateResultInterface> {
    const account = await this.db.webAccount.findUnique({
      where: { userId },
      select: FIRST_PASSWORD_ACCOUNT_SELECT,
    });
    if (account === null) throw new NotFoundException('Web account not found');
    return { hasPassword: account.passwordHash !== null, login: account.login };
  }

  /**
   * `moment` fixes the sign-out moment (a spec does); otherwise it is taken
   * once the password is hashed — a moment taken before scrypt would be older
   * than the write that carries it, and a session opened in that gap would
   * survive the new password.
   */
  public async set(
    userId: string,
    newPassword: string,
    moment?: Date,
  ): Promise<WebFirstPasswordResultInterface> {
    const account = await this.db.webAccount.findUnique({
      where: { userId },
      select: FIRST_PASSWORD_ACCOUNT_SELECT,
    });
    if (account === null || account.login === null || account.user.isBlocked) {
      return { status: 'no_account' };
    }
    if (account.passwordHash !== null) return { status: 'has_password' };

    const passwordHash = await this.hasher.hashPassword({
      plainTextPassword: newPassword,
      audience: 'subscriber',
    });
    const now = moment ?? new Date();
    const written = await this.db.$transaction(async (tx) => {
      // The `where` is the guard, not the check above: between that read and
      // this write another request may have set a password, and then this one
      // matches nothing — and signs nobody out.
      const { count } = await tx.webAccount.updateMany({
        where: { id: account.id, passwordHash: null },
        data: {
          passwordHash,
          passwordBootstrapPending: false,
          requiresPasswordChange: false,
          temporaryPasswordExpiresAt: null,
          credentialsBootstrappedAt: account.credentialsBootstrappedAt ?? now,
        },
      });
      if (count !== 1) return false;
      await raiseSessionsRevokedAt(tx, account.id, now);
      return true;
    });
    if (!written) return { status: 'has_password' };
    this.logger.log(`A first password was set from a signed-in session (web account ${account.id})`);
    return { status: 'set', login: account.login, sessionsRevokedAt: now.toISOString() };
  }
}
