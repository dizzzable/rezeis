import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * WHO HAS TO LEAVE THE ANONYMOUS HOLDER OUT, AND WHY A LIST RATHER THAN A RULE.
 *
 * «Удалить полностью» leaves one row in `users` that is not a person: it holds
 * the money history of a deleted account so revenue already reported for a
 * closed month is not silently rewritten (`anonymized-user.util.ts`). It has no
 * Telegram id, no e-mail, no login and no name.
 *
 * A read that answers a question about CUSTOMERS must exclude it, and a read
 * that answers a question about MONEY or ACQUISITION must not — that is the
 * whole point of keeping the row. No automatic rule can tell those apart, so
 * the readers are named here one by one. A new customer-facing read that
 * forgets the filter is not caught by this file; a change that silently drops
 * the filter from one of these IS, and those are the ones nobody would notice:
 * «Всего пользователей» creeping up by one per deletion, a blank row on the
 * Users page, a blank line in an export.
 *
 * The behaviour itself — that a full deletion produces such a row at all, and
 * that the list clause really excludes it — is proved against Postgres in
 * `user-full-deletion-postgres.spec.ts`. This file guards the OTHER readers,
 * which have no cheap database test of their own.
 */

const SRC = join(__dirname, '..', 'src');

/**
 * Each entry: the file, and the line it must carry.
 *
 * Matched on the whole file rather than on a line number so an unrelated edit
 * above does not fail this, and on the CONSTANT rather than on the column name
 * so a hand-written `anonymizedAt: null` somewhere else cannot satisfy it —
 * one reader is the point.
 */
const CUSTOMER_FACING_READERS: ReadonlyArray<{
  readonly file: string;
  readonly what: string;
}> = [
  {
    file: 'modules/users/services/admin-users.service.ts',
    what: 'the Users list and its total — and, through the same builder, the export',
  },
  {
    file: 'modules/dashboard/services/dashboard.service.ts',
    what: 'the three dashboard customer counters',
  },
  {
    file: 'modules/users/services/user-export.service.ts',
    what: 'the users export',
  },
  {
    file: 'modules/users/services/registration-export.service.ts',
    what: 'the registrations export',
  },
  {
    file: 'modules/broadcast/services/broadcast.service.ts',
    what: 'the audience size shown before a broadcast is sent',
  },
  {
    file: 'modules/business-analytics/services/business-analytics.service.ts',
    what: '«Всего пользователей» on the analytics overview',
  },
];

/**
 * The same rule where the read is hand-written SQL.
 *
 * Matched on the predicate rather than on the constant: `Prisma.sql` takes a
 * fragment, not an object, so these cannot spread `NOT_ANONYMIZED_USER`.
 */
const CUSTOMER_FACING_SQL: ReadonlyArray<{ readonly file: string; readonly what: string }> = [
  {
    file: 'modules/business-analytics/utils/analytics-overview.util.ts',
    what: 'the «новых пользователей» series, which must agree with the dashboard counter beside it',
  },
  {
    file: 'modules/business-analytics/utils/usage-surface-report.util.ts',
    what: 'the surface / form-factor / OS head-counts',
  },
];

/**
 * READS THAT MUST NOT FILTER, and this is not an omission.
 *
 * Each of these hangs MONEY or ATTRIBUTION off the same user row: the funnel
 * joins transactions to its cohort, retention joins them by month, and every
 * advertising figure — spend, payback, revenue per placement — is computed
 * from the attributed users. Excluding the holder there would take the
 * deleted customer's payments out with it, which is the exact outcome the
 * holder exists to prevent and the one the owner decided against on
 * 21.09.2026.
 */
const MONEY_BEARING_READERS: ReadonlyArray<{ readonly file: string; readonly what: string }> = [
  {
    file: 'modules/business-analytics/utils/analytics-retention.util.ts',
    what: 'retention, which joins payments to its monthly cohort',
  },
  {
    file: 'modules/advertising/services/ad-metrics.service.ts',
    what: 'advertising payback, computed from the attributed users',
  },
];

function source(file: string): string {
  return readFileSync(join(SRC, file), 'utf8');
}

describe('an anonymous holder is not a customer', () => {
  for (const reader of CUSTOMER_FACING_READERS) {
    it(`excludes it from ${reader.what}`, () => {
      const text = source(reader.file);
      assert.match(
        text,
        /NOT_ANONYMIZED_USER/,
        `${reader.file} answers a question about customers and must spread NOT_ANONYMIZED_USER ` +
          "into its `where`; without it a full deletion adds one row to this answer every time.",
      );
      assert.match(
        text,
        /from '(\.\.\/)+(modules\/)?(users\/)?utils\/anonymized-user\.util'/,
        `${reader.file} must take the constant from users/utils/anonymized-user.util — a local ` +
          'copy is a second definition free to drift from the column it names.',
      );
    });
  }

  it('applies it in the list builder itself, not at each call site', () => {
    // The list and the count share `buildUserListWhere`, and the export shares
    // it too. Applied at the call sites instead, "what I see", "the number I
    // was shown" and "what I downloaded" would be three populations that agree
    // most of the time — the worst kind of disagreement, because it is noticed
    // only when a campaign reaches the wrong people.
    const text = source('modules/users/services/admin-users.service.ts');
    assert.match(
      text,
      /and\.push\(\{ \.\.\.NOT_ANONYMIZED_USER \}\)/,
      'the filter must be an AND term of the shared builder',
    );
  });

  for (const reader of CUSTOMER_FACING_SQL) {
    it(`excludes it from ${reader.what}`, () => {
      assert.match(
        source(reader.file),
        /"anonymized_at" IS NULL/,
        `${reader.file} counts people in hand-written SQL and must carry the predicate; ` +
          'see `anonymized-user.util.ts` for why the rule has two forms.',
      );
    });
  }

  for (const reader of MONEY_BEARING_READERS) {
    it(`leaves ${reader.what} alone`, () => {
      // ANTI-VACUITY, and the rule that keeps this file honest. "Put it
      // everywhere" would pass every case above and take the deleted account's
      // payments out of the revenue reports — which is the exact outcome the
      // holder exists to prevent, and the one the owner decided against on
      // 21.09.2026.
      const text = source(reader.file);
      assert.doesNotMatch(text, /NOT_ANONYMIZED_USER/);
      assert.doesNotMatch(text, /"anonymized_at" IS NULL/);
    });
  }

  it('states the exception in the one place that defines the rule', () => {
    const util = readFileSync(join(SRC, 'modules', 'users', 'utils', 'anonymized-user.util.ts'), 'utf8');
    assert.match(util, /Reads that answer a question about MONEY or ACQUISITION must keep it/);
  });
});
