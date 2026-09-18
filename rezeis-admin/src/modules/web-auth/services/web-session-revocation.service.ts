import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  WebSessionsRevokeResultInterface,
  WebSessionsStateResultInterface,
} from '../interfaces/web-auth.interface';
import { raiseSessionsRevokedAtForUser, type SessionsRevokedAtWriter } from '../utils/sessions-revoked-at.util';

/**
 * Signing a customer's cabinet sessions out, all at once
 * ══════════════════════════════════════════════════════
 * A cabinet session is an opaque key in the cabinet's Redis, with no index by
 * customer, so nothing can enumerate a customer's sessions to end them. What
 * can be done is to name a MOMENT: `web_accounts.sessions_revoked_at`. Every
 * session that started before it is signed out the next time the cabinet
 * checks — at most a minute after it was written, because each session asks at
 * most once a minute (`state` below).
 *
 * The moment is written by a password reset (any channel, in
 * `PasswordResetService.consume`), a password change (`WebAuthService
 * .changePassword`), a first password (`WebFirstPasswordService.set`) and an
 * operator's temporary password (`AdminUserWebController.resetWebPassword`) —
 * each in the same transaction as the new password — and by «Выйти на всех
 * устройствах» (`revokeAll`). Every one of them writes it through
 * `sessions-revoked-at.util.ts`, which never moves it back. The browser that
 * did it is handed a fresh session by the cabinet, one that counts from the
 * moment, so it stays signed in.
 *
 * The moment is on the PANEL's clock, and a session's start is on the
 * cabinet's. `state` therefore answers with the panel's `now` beside it: the
 * cabinet estimates the difference between the two clocks from it and the
 * round trip, and compares on one clock.
 *
 * In Postgres, not in the cabinet's Redis: a Redis key can be evicted under
 * memory pressure or lost with an unpersisted restart, and a lost revocation
 * silently brings every ended session back.
 *
 * A customer with no web account — a Telegram-only one — has nowhere to keep
 * the moment: their sessions are proven by Telegram, not a password, and
 * `state` reports nothing revoked.
 */

export interface WebSessionRevocationDatabase extends SessionsRevokedAtWriter {
  readonly webAccount: {
    findUnique(args: {
      where: Prisma.WebAccountWhereUniqueInput;
      select: { sessionsRevokedAt: true };
    }): PromiseLike<{ sessionsRevokedAt: Date | null } | null>;
  };
}

/** DI token for the database port. */
export const WEB_SESSION_REVOCATION_DATABASE = Symbol('WEB_SESSION_REVOCATION_DATABASE');

/** The real client, typed as the port — this line is the compile-time proof it fits. */
export function asWebSessionRevocationDatabase(prisma: PrismaService): WebSessionRevocationDatabase {
  return prisma;
}

@Injectable()
export class WebSessionRevocationService {
  public constructor(
    @Inject(WEB_SESSION_REVOCATION_DATABASE) private readonly db: WebSessionRevocationDatabase,
  ) {}

  /**
   * The moment before which every session of this customer is signed out, if
   * any — and the panel's clock at the time of the answer.
   */
  public async state(userId: string): Promise<WebSessionsStateResultInterface> {
    const row = await this.db.webAccount.findUnique({
      where: { userId },
      select: { sessionsRevokedAt: true },
    });
    return {
      sessionsRevokedAt: row?.sessionsRevokedAt?.toISOString() ?? null,
      now: new Date().toISOString(),
    };
  }

  /**
   * «Выйти на всех устройствах»: every session that started before now is
   * signed out. The answer is THIS moment — the one the browser that pressed it
   * counts from — even when a later one already stands.
   */
  public async revokeAll(userId: string, now: Date = new Date()): Promise<WebSessionsRevokeResultInterface> {
    const count = await raiseSessionsRevokedAtForUser(this.db, userId, now);
    if (count === 0) throw new NotFoundException('Web account not found');
    return { sessionsRevokedAt: now.toISOString() };
  }
}
