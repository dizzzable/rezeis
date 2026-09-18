import { Prisma } from '@prisma/client';

/**
 * Moving the sign-out moment forward, never back
 * ══════════════════════════════════════════════
 * `web_accounts.sessions_revoked_at` is the moment before which every cabinet
 * session of the account is signed out. Five paths write it, and every one of
 * them writes it through here:
 *   - a password reset, on every channel (`PasswordResetService.consume`);
 *   - a password change (`WebAuthService.changePassword`);
 *   - a first password (`WebFirstPasswordService.set`);
 *   - an operator's temporary password (`AdminUserWebController.resetWebPassword`);
 *   - «Выйти на всех устройствах» (`WebSessionRevocationService.revokeAll`).
 *
 * WHY NOT A PLAIN ASSIGNMENT. Two of these can race, and the one that took
 * the EARLIER moment can commit LATER: each takes its moment once its new
 * password is hashed, and scrypt, a lock wait or a pause can hold one writer
 * back after it did. A plain `= moment` then moves the moment back, and every
 * session that started between the two moments survives the later change —
 * for the rest of its 30 days. `GREATEST(COALESCE(sessions_revoked_at, m), m)`
 * keeps the later of the two whatever the order of the commits: PostgreSQL
 * evaluates it against the row version it has locked, so a writer that waited
 * for another one's lock sees that one's moment.
 *
 * WHY A SEPARATE STATEMENT. Prisma's update has no way to say "the later of the
 * column and this value". Every writer runs this in the SAME TRANSACTION as its
 * new password, so there is still never a new password without the moment.
 *
 * `updated_at` is set as Prisma's `@updatedAt` would: this statement bypasses
 * the client that normally does it.
 *
 * The moment is bound as a `Date`, like every timestamp the panel writes
 * through Prisma, so it is stored exactly as a typed write would store it (see
 * `panelInstantSql` on how the pg adapter binds a `Date`) and read back as the
 * same instant.
 */

/** The only thing this needs of a Prisma client or transaction. */
export interface SessionsRevokedAtWriter {
  $executeRaw(query: Prisma.Sql): PromiseLike<number>;
}

/** Signs out every session of this web account that started before `moment` — unless a later moment stands. */
export function raiseSessionsRevokedAt(
  db: SessionsRevokedAtWriter,
  webAccountId: string,
  moment: Date,
): PromiseLike<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE "web_accounts"
       SET "sessions_revoked_at" = GREATEST(COALESCE("sessions_revoked_at", ${moment}::timestamptz), ${moment}::timestamptz),
           "updated_at" = CURRENT_TIMESTAMP
     WHERE "id" = ${webAccountId}`);
}

/** The same, for the web account of a customer. The count is 0 when the customer has none. */
export function raiseSessionsRevokedAtForUser(
  db: SessionsRevokedAtWriter,
  userId: string,
  moment: Date,
): PromiseLike<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE "web_accounts"
       SET "sessions_revoked_at" = GREATEST(COALESCE("sessions_revoked_at", ${moment}::timestamptz), ${moment}::timestamptz),
           "updated_at" = CURRENT_TIMESTAMP
     WHERE "user_id" = ${userId}`);
}
