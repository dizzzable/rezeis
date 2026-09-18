import assert from 'node:assert/strict';

import type { Prisma } from '@prisma/client';

/**
 * What PostgreSQL does with the ONE statement every writer of the sign-out
 * moment runs (`raiseSessionsRevokedAt` / `…ForUser`), for the in-memory fakes
 * of the specs that cover those writers — and nothing else: any other SQL
 * fails the case that sent it.
 *
 * The text is written out here, not imported, so a change to the statement
 * fails these fakes instead of changing them with it. That the statement does
 * what this fake does on a real database is `web-first-password-postgres.spec.ts`.
 */
export interface RevocableRow {
  readonly id: string;
  readonly userId: string;
  sessionsRevokedAt: Date | null;
}

const GREATEST_SET =
  'UPDATE "web_accounts" SET "sessions_revoked_at" = GREATEST(COALESCE("sessions_revoked_at", $1::timestamptz), $2::timestamptz), "updated_at" = CURRENT_TIMESTAMP';
const BY_ACCOUNT = `${GREATEST_SET} WHERE "id" = $3`;
const BY_USER = `${GREATEST_SET} WHERE "user_id" = $3`;

/** Applies the statement to `rows` as PostgreSQL would; returns the row count it reports. */
export function applySessionsRevokedAtRaise(query: Prisma.Sql, rows: readonly RevocableRow[]): number {
  const text = query.text.replace(/\s+/g, ' ').trim();
  assert.ok(text === BY_ACCOUNT || text === BY_USER, `not the statement that raises the sign-out moment: ${text}`);
  const [first, second, key] = query.values;
  assert.ok(first instanceof Date && second instanceof Date, 'the moment is bound as a Date, twice');
  assert.equal(first.getTime(), second.getTime(), 'the two bindings are the same moment');
  assert.equal(typeof key, 'string', 'the row is named by a string key');
  const hit = rows.filter((row) => (text === BY_ACCOUNT ? row.id : row.userId) === key);
  for (const row of hit) {
    if (row.sessionsRevokedAt === null || row.sessionsRevokedAt.getTime() < first.getTime()) {
      row.sessionsRevokedAt = new Date(first.getTime());
    }
  }
  return hit.length;
}
