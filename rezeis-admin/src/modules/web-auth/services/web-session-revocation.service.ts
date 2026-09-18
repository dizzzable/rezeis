import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  WebSessionsRevokeResultInterface,
  WebSessionsStateResultInterface,
} from '../interfaces/web-auth.interface';

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
 * .changePassword`) and a first password (`WebFirstPasswordService.set`) — each
 * in the same statement as the new password — and by «Выйти на всех
 * устройствах» (`revokeAll`). The browser that did it is handed a fresh session
 * by the cabinet, one that counts from the moment, so it stays signed in.
 *
 * In Postgres, not in the cabinet's Redis: a Redis key can be evicted under
 * memory pressure or lost with an unpersisted restart, and a lost revocation
 * silently brings every ended session back.
 *
 * A customer with no web account — a Telegram-only one — has nowhere to keep
 * the moment: their sessions are proven by Telegram, not a password, and
 * `state` reports nothing revoked.
 */

export interface WebSessionRevocationDatabase {
  readonly webAccount: {
    findUnique(args: {
      where: Prisma.WebAccountWhereUniqueInput;
      select: { sessionsRevokedAt: true };
    }): PromiseLike<{ sessionsRevokedAt: Date | null } | null>;
    updateMany(args: {
      where: Prisma.WebAccountWhereInput;
      data: Prisma.WebAccountUpdateManyMutationInput;
    }): PromiseLike<Prisma.BatchPayload>;
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

  /** The moment before which every session of this customer is signed out, if any. */
  public async state(userId: string): Promise<WebSessionsStateResultInterface> {
    const row = await this.db.webAccount.findUnique({
      where: { userId },
      select: { sessionsRevokedAt: true },
    });
    return { sessionsRevokedAt: row?.sessionsRevokedAt?.toISOString() ?? null };
  }

  /** «Выйти на всех устройствах»: every session that started before now is signed out. */
  public async revokeAll(userId: string, now: Date = new Date()): Promise<WebSessionsRevokeResultInterface> {
    const { count } = await this.db.webAccount.updateMany({
      where: { userId },
      data: { sessionsRevokedAt: now },
    });
    if (count === 0) throw new NotFoundException('Web account not found');
    return { sessionsRevokedAt: now.toISOString() };
  }
}
