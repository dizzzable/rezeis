import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';

import {
  DERIVED_LEVEL_2_ID_PREFIX,
  ReferralsService,
  deriveLevel2RowId,
} from '../src/modules/referrals/services/referrals.service';

// Every date in this file is derived from a clock the test controls. An
// absolute literal is true on the morning it is typed and silently becomes
// something else months later - that has already cost this repo thirty green
// tests asserting an expired-subscription defect.
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(NOW - days * DAY_MS + 4_321);
const daysAhead = (days: number): Date => new Date(NOW + days * DAY_MS + 4_321);

/**
 * The invite lifetime the OPERATOR configured, as
 * `ReferralInviteLimitsService.resolveInviteExpiry` answers it. NINE days, not
 * thirty: thirty was the window the service used to hardcode, so a 30-day
 * fixture cannot tell "the operator's setting was used" from "the setting was
 * ignored".
 */
const OPERATOR_EXPIRY = daysAhead(9);

/**
 * The two questions `ReferralsService.createInvite` asks the limits service.
 *
 * It asks BOTH before it writes a row - the admin route used to write one
 * without asking either - so the collaborator has to be supplied here even by
 * cases that are about row shape rather than about quota or expiry. Stated as
 * "there is room" and "the operator configured nine days" rather than left
 * undefined: an undefined collaborator would fail these with a TypeError that
 * looks nothing like the behaviour they pin.
 *
 * Their own behaviour is pinned elsewhere - the quota in
 * `referral-invite-admin-quota.spec.ts`, the TTL end to end in
 * `referral-invite-expiry.spec.ts`.
 */
const ROOMY_INVITE_LIMITS = {
  getCapacity: async (): Promise<unknown> => ({
    totalSlots: 5,
    usedSlots: 1,
    remainingSlots: 4,
    canCreateInvite: true,
  }),
  resolveInviteExpiry: async (): Promise<Date | null> => OPERATOR_EXPIRY,
} as never;

/**
 * Carries EVERY column `REFERRAL_USER_SUMMARY_SELECT` asks Prisma for, each
 * with a distinct non-null value.
 *
 * That is the point, not padding: the whole-object `deepStrictEqual` below can
 * only catch a field the mapper drops if the fixture actually supplied one.
 * The version of this fixture that shipped the bug returned neither `level`
 * nor `inviteSource`, so the assertion that the output must NOT contain them
 * was true for the wrong reason and pinned the truncated projection in place.
 */
function user(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    username: `${id}-username`,
    name: `${id}-name`,
    telegramId: BigInt('123456789'),
    email: `${id}@example.test`,
    webAccount: { login: `${id}-login`, email: `${id}-wa@example.test` },
    createdAt: daysAgo(120),
    ...overrides,
  };
}

/** The per-user column projection the service must hand Prisma. */
const EXPECTED_USER_SELECT = {
  id: true,
  username: true,
  name: true,
  telegramId: true,
  email: true,
  webAccount: { select: { login: true, email: true } },
  createdAt: true,
};

/**
 * The operator form's own spelling, with BOTH levels funded. It is the default
 * so that `payoutBlockedBy` is `null` unless a case deliberately turns a level
 * off - an unfunded default would make every unrelated assertion below read as
 * "no reward configured" and quietly stop testing what it was written for.
 */
const BOTH_LEVELS_FUNDED = { rewardType: 'POINTS', level1Reward: 100, level2Reward: 50 };

interface PartnerRow {
  readonly userId: string;
  readonly isActive: boolean;
}

/** A level-2 edge as it sits in the table: `referrerId` REFERRED `referredId`. */
interface AncestorEdge {
  readonly referredId: string;
  readonly referrerId: string;
}

interface PrismaStubOptions {
  readonly rows: readonly unknown[];
  readonly ancestors?: readonly AncestorEdge[];
  readonly partners?: readonly PartnerRow[];
  readonly referralSettings?: unknown;
  readonly onPageArgs?: (args: unknown) => void;
}

interface Probe {
  readonly service: ReferralsService;
  /** One entry per query issued, in order. */
  readonly calls: readonly string[];
  readonly ancestorWheres: readonly unknown[];
  readonly partnerWheres: readonly unknown[];
}

/**
 * A Prisma stub that ANSWERS like a table rather than replaying a fixture.
 *
 * `referral.findMany` for ancestors honours `where.referredId.in`, and
 * `partner.findMany` honours BOTH `where.userId.in` and `where.isActive`. That
 * is what lets the cases below assert on returned rows instead of on the
 * arguments a mock was handed: drop `isActive: true` from the service's where
 * clause and the inactive-partner fixture starts coming back, which changes
 * the rows and fails a named test - an argument-shape assertion would have
 * been satisfied by any where clause at all.
 *
 * The two `referral.findMany` calls are told apart the way Prisma itself would
 * see them: the page carries `include`, the ancestor lookup carries `select`.
 */
function probe(options: PrismaStubOptions): Probe {
  const calls: string[] = [];
  const ancestorWheres: unknown[] = [];
  const partnerWheres: unknown[] = [];
  const ancestors = options.ancestors ?? [];
  const partners = options.partners ?? [];

  const service = new ReferralsService({
    referral: {
      findMany: async (args: Record<string, unknown>) => {
        if (args.include !== undefined) {
          calls.push('referral.findMany(page)');
          options.onPageArgs?.(args);
          return options.rows;
        }
        calls.push('referral.findMany(ancestors)');
        const where = args.where as { referredId: { in: readonly string[] } };
        ancestorWheres.push(where);
        return ancestors
          .filter((edge) => where.referredId.in.includes(edge.referredId))
          .map((edge) => ({
            referredId: edge.referredId,
            referrerId: edge.referrerId,
            referrer: user(edge.referrerId),
          }));
      },
    },
    partner: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push('partner.findMany');
        const where = args.where as { userId: { in: readonly string[] }; isActive?: boolean };
        partnerWheres.push(where);
        return partners
          .filter((row) => where.userId.in.includes(row.userId))
          .filter((row) => where.isActive === undefined || row.isActive === where.isActive)
          .map((row) => ({ userId: row.userId }));
      },
    },
    settings: {
      findFirst: async () => {
        calls.push('settings.findFirst');
        return { referralSettings: options.referralSettings ?? BOTH_LEVELS_FUNDED };
      },
    },
  } as never, ROOMY_INVITE_LIMITS);

  return { service, calls, ancestorWheres, partnerWheres };
}

function serviceReturning(rows: readonly unknown[], onArgs?: (args: unknown) => void) {
  return probe({ rows, onPageArgs: onArgs }).service;
}

/** One registration row as `REFERRAL_INCLUDE` delivers it. */
function registration(input: {
  readonly id: string;
  readonly referrerId: string;
  readonly referredId: string;
  readonly level?: number;
  readonly inviteSource?: string;
  readonly qualifiedAt?: Date | null;
  readonly createdAt?: Date;
}) {
  return {
    id: input.id,
    referrerId: input.referrerId,
    referrer: user(input.referrerId),
    referred: user(input.referredId),
    level: input.level ?? 1,
    inviteSource: input.inviteSource ?? 'BOT',
    qualifiedAt: input.qualifiedAt ?? null,
    createdAt: input.createdAt ?? daysAgo(3),
  };
}

/** `[level, who earns it, why it will not pay]` for each returned row. */
function payoutShape(
  rows: readonly {
    level: number;
    referrer: { id: string };
    payoutBlockedBy: string | null;
  }[],
): readonly [number, string, string | null][] {
  return rows.map((row) => [row.level, row.referrer.id, row.payoutBlockedBy]);
}

/**
 * Runs one referral through the real service and returns the label the panel
 * would print for its referrer. `overrides` describes the referrer only.
 */
async function referrerDisplayName(overrides: Record<string, unknown>): Promise<string> {
  const service = serviceReturning([
    {
      id: 'referral-1',
      referrerId: 'referrer',
      referrer: user('referrer', overrides),
      referred: user('referred'),
      level: 1,
      inviteSource: 'UNKNOWN',
      qualifiedAt: null,
      createdAt: daysAgo(2),
    },
  ]);
  const result = await service.listReferrals({});
  return result[0].referrer.displayName;
}

describe('ReferralsService', () => {
  it('projects level and inviteSource alongside the mapped user summaries', async () => {
    let findManyArgs: unknown;
    const referrer = user('referrer');
    const referred = user('referred', { name: '' });
    const referralCreatedAt = daysAgo(3);
    const qualifiedAt = daysAgo(1);
    const service = serviceReturning(
      [
        {
          id: 'referral-1',
          referrerId: 'referrer',
          referrer,
          referred,
          // Neither value is the schema default (`level` 1, `inviteSource`
          // UNKNOWN). With the defaults, "the column was projected" and
          // "something invented a constant" produce the same assertion.
          level: 3,
          inviteSource: 'WEB',
          qualifiedAt,
          createdAt: referralCreatedAt,
        },
      ],
      (args) => {
        findManyArgs = args;
      },
    );

    const result = await service.listReferrals({
      referrerId: 'referrer',
      qualified: 'true',
      limit: 10,
      offset: 5,
    });

    assert.deepStrictEqual(findManyArgs, {
      where: { referrerId: 'referrer', referredId: undefined, qualifiedAt: { not: null } },
      include: {
        referrer: { select: EXPECTED_USER_SELECT },
        referred: { select: EXPECTED_USER_SELECT },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
      skip: 5,
    });
    // Whole-object, and the fixture above carries every selected column - so a
    // field the mapper drops fails HERE instead of matching a shorter
    // expectation that was written around the drop.
    assert.deepStrictEqual(result, [{
      id: 'referral-1',
      referrer: {
        id: 'referrer',
        username: 'referrer-username',
        name: 'referrer-name',
        displayName: 'referrer-name',
        telegramId: '123456789',
        createdAt: referrer.createdAt.toISOString(),
      },
      referred: {
        id: 'referred',
        username: 'referred-username',
        name: null,
        displayName: 'referred-username',
        telegramId: '123456789',
        createdAt: referred.createdAt.toISOString(),
      },
      level: 3,
      inviteSource: 'WEB',
      qualifiedAt: qualifiedAt.toISOString(),
      createdAt: referralCreatedAt.toISOString(),
      // Both levels are funded and this referrer is not a partner, so the
      // engine WILL pay them - which is exactly what `null` claims here.
      payoutBlockedBy: null,
    }]);
  });

  it('forwards every level and invite source verbatim rather than a constant', async () => {
    const cases = [
      { level: 1, inviteSource: 'BOT' as const },
      { level: 2, inviteSource: 'WEB' as const },
      { level: 3, inviteSource: 'UNKNOWN' as const },
    ];
    const service = serviceReturning(
      cases.map((row, index) => ({
        id: `referral-${index}`,
        referrerId: `referrer-${index}`,
        referrer: user(`referrer-${index}`),
        referred: user(`referred-${index}`),
        level: row.level,
        inviteSource: row.inviteSource,
        qualifiedAt: null,
        createdAt: daysAgo(index + 1),
      })),
    );

    const result = await service.listReferrals({});

    assert.deepStrictEqual(
      result.map((row) => ({ level: row.level, inviteSource: row.inviteSource })),
      cases,
    );
  });

  // -- Printable identity ---------------------------------------------------
  //
  // `Referral.referrerId` is NOT NULL with a required relation, so a referrer
  // ALWAYS exists. The panel printing a dash for one is therefore always the
  // projection's fault and never the data's. Each case below strips everything
  // above one rung of the fallback chain and pins what is left.

  it('prefers the profile name when the referrer has a Telegram identity', async () => {
    assert.equal(await referrerDisplayName({}), 'referrer-name');
  });

  it('names a Telegram-only referrer by Telegram id when nothing else is set', async () => {
    assert.equal(
      await referrerDisplayName({ name: '', username: null, email: null, webAccount: null }),
      'TG 123456789',
    );
  });

  it('names a web-only referrer by web login', async () => {
    // The production shape: `WebAuthService` creates web sign-ups as
    // `{ name: '', email }` with no username and no telegramId. Before
    // `displayName` existed this referrer had no printable identity at all.
    assert.equal(
      await referrerDisplayName({
        name: '',
        username: null,
        telegramId: null,
        email: null,
        webAccount: { login: 'web-only-login', email: null },
      }),
      'web-only-login',
    );
  });

  it('names a referrer that has only an email', async () => {
    assert.equal(
      await referrerDisplayName({
        name: '',
        username: null,
        telegramId: null,
        email: 'only-email@example.test',
        webAccount: null,
      }),
      'only-email@example.test',
    );
  });

  it('falls through to the web account email when the account has no login', async () => {
    assert.equal(
      await referrerDisplayName({
        name: '',
        username: null,
        telegramId: null,
        email: null,
        webAccount: { login: null, email: 'account-only@example.test' },
      }),
      'account-only@example.test',
    );
  });

  it('ignores a whitespace-only name instead of printing it', async () => {
    // `??` would have accepted '   ' as a name and painted blank space. The
    // chain trims, so it keeps walking.
    assert.equal(
      await referrerDisplayName({
        name: '   ',
        username: null,
        telegramId: null,
        email: null,
        webAccount: { login: 'web-only-login', email: null },
      }),
      'web-only-login',
    );
  });

  it('falls back to the user id, never to an empty label', async () => {
    const displayName = await referrerDisplayName({
      name: '',
      username: null,
      telegramId: null,
      email: null,
      webAccount: null,
    });

    assert.equal(displayName, 'referrer');
    assert.notEqual(displayName, '');
  });

  it('creates invite tokens only for existing inviters and maps the created row', async () => {
    // Derived from the test's own clock, never a literal. This case used to
    // hardcode '2026-05-01', which was FUTURE when it was written and had
    // quietly become past. Nothing branched on that yet - `resolveInviteExpiry`
    // had no past/future distinction - so it stayed green while no longer
    // meaning what its author wrote. It did block one thing: any future-expiry
    // guard on this path would have failed here for reasons unrelated to the
    // guard, on whatever morning someone added it.
    //
    // 45 days and an odd millisecond offset, so this fixture matches neither
    // the operator's configured answer (`OPERATOR_EXPIRY`, nine days) nor the
    // 30-day window the service used to hardcode. Otherwise "the requested
    // expiry was used" and "the request was ignored and the default applied"
    // would be the same assertion. Mutation-checked - dropping the explicit
    // expiry has to fail this case, and with a colliding fixture it did not.
    const expiry = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000 + 54_321);
    let createArgs: unknown;
    const service = new ReferralsService({
      user: { findUnique: async () => ({ id: 'inviter-1' }) },
      referralInvite: {
        create: async (args: unknown) => {
          createArgs = args;
          // Echo the expiry the SERVICE resolved rather than a fixture of our
          // own. The hardcoded return used to make the final assertion a test
          // of `mapReferralInvite` alone - the input `expiresAt` could have
          // been dropped on the floor and this case would not have noticed.
          const data = (args as { data: { expiresAt: Date | null } }).data;
          return {
            id: 'invite-1',
            token: 'generated-token',
            inviter: user('inviter-1'),
            note: 'hello',
            expiresAt: data.expiresAt,
            revokedAt: null,
            consumedAt: null,
            createdAt: daysAgo(10),
          };
        },
      },
    } as never, ROOMY_INVITE_LIMITS);

    const result = await service.createInvite({
      inviterId: 'inviter-1',
      note: 'hello',
      expiresAt: expiry.toISOString(),
    });

    assert.equal((createArgs as { data: { inviterId: string; note: string } }).data.inviterId, 'inviter-1');
    assert.equal(typeof (createArgs as { data: { token: string } }).data.token, 'string');
    assert.equal((createArgs as { data: { note: string } }).data.note, 'hello');
    // The requested expiry actually reaches Prisma...
    assert.deepStrictEqual((createArgs as { data: { expiresAt: Date | null } }).data.expiresAt, expiry);
    // ...and comes back out as an ISO string.
    assert.deepStrictEqual(result.invite.expiresAt, expiry.toISOString());
    // The inviter is named by the same mapper a referrer is - one rule, not two.
    assert.equal(result.invite.inviter.displayName, 'inviter-1-name');
  });

  it('honours an explicit null expiry instead of applying the default TTL', async () => {
    // "TTL disabled" and the per-user VIP bypass both resolve to "no expiry".
    // They reach this service as `expiresAt: null`; treating that like an
    // absent field silently re-imposed a 30-day window on links meant to be
    // permanent - so the bypass appeared to do nothing end-to-end.
    let createArgs: unknown;
    const service = new ReferralsService({
      user: { findUnique: async () => ({ id: 'inviter-1' }) },
      referralInvite: {
        create: async (args: unknown) => {
          createArgs = args;
          return {
            id: 'invite-1',
            token: 'generated-token',
            inviter: user('inviter-1'),
            note: null,
            expiresAt: null,
            revokedAt: null,
            consumedAt: null,
            createdAt: daysAgo(10),
          };
        },
      },
    } as never, ROOMY_INVITE_LIMITS);

    const result = await service.createInvite({ inviterId: 'inviter-1', expiresAt: null });

    assert.equal((createArgs as { data: { expiresAt: Date | null } }).data.expiresAt, null);
    assert.equal(result.invite.expiresAt, null);
  });

  it("defers to the operator's configured lifetime when no expiry is specified", async () => {
    // This case used to assert only `expiresAt instanceof Date`, which was true
    // of the hardcoded 30-day window the service invented for exactly this call
    // shape - the one both panel surfaces send. It now pins the identity: the
    // instant written is the one the limits service answered with, so a service
    // that re-derives any window of its own fails here.
    let createArgs: unknown;
    const service = new ReferralsService({
      user: { findUnique: async () => ({ id: 'inviter-1' }) },
      referralInvite: {
        create: async (args: unknown) => {
          createArgs = args;
          const data = (args as { data: { expiresAt: Date | null } }).data;
          return {
            id: 'invite-1',
            token: 'generated-token',
            inviter: user('inviter-1'),
            note: null,
            // Echo what the SERVICE resolved: a hardcoded return here would
            // make the mapped result agree no matter what reached Prisma.
            expiresAt: data.expiresAt,
            revokedAt: null,
            consumedAt: null,
            createdAt: daysAgo(10),
          };
        },
      },
    } as never, ROOMY_INVITE_LIMITS);

    const result = await service.createInvite({ inviterId: 'inviter-1' });

    assert.deepStrictEqual(
      (createArgs as { data: { expiresAt: Date | null } }).data.expiresAt,
      OPERATOR_EXPIRY,
    );
    assert.equal(result.invite.expiresAt, OPERATOR_EXPIRY.toISOString());
  });

  it('rejects invite creation for missing inviters', async () => {
    const service = new ReferralsService({
      user: { findUnique: async () => null },
    } as never, ROOMY_INVITE_LIMITS);

    await assert.rejects(service.createInvite({ inviterId: 'missing' }), NotFoundException);
  });
});

/**
 * A ---> B ---> C.  A referred B; B referred C.
 *
 * C's REGISTRATION is one database row (`Referral.referredId` is `@unique`, so
 * C has exactly one referrer, ever). Two people can be paid for it: B at level
 * 1, from the row itself, and A at level 2, which
 * `ReferralQualificationService.createConfiguredRewards` derives at payout
 * time by walking one step up. The list derives it the same way, so the table
 * can say which level a payout is instead of showing a permanent, useless 1.
 */
describe('ReferralsService.listReferrals - the level-2 payout row', () => {
  const REGISTRATION = registration({ id: 'edge-c', referrerId: 'b', referredId: 'c' });
  const A_REFERRED_B: AncestorEdge = { referredId: 'b', referrerId: 'a' };

  it('pays B at level 1 and A at level 2 for the one registration', async () => {
    const { service } = probe({ rows: [REGISTRATION], ancestors: [A_REFERRED_B] });

    const rows = await service.listReferrals({});

    assert.deepStrictEqual(payoutShape(rows), [
      [1, 'b', null],
      [2, 'a', null],
    ]);
    // The derived row is ABOUT the same registration: same invitee, same
    // signup, same qualification. Only the earner and the level differ.
    assert.equal(rows[1].referred.id, 'c');
    assert.equal(rows[1].referred.id, rows[0].referred.id);
    assert.equal(rows[1].inviteSource, rows[0].inviteSource);
    assert.equal(rows[1].qualifiedAt, rows[0].qualifiedAt);
    assert.equal(rows[1].createdAt, rows[0].createdAt);
  });

  it('names the GRANDPARENT on the level-2 row, not the referrer beside it', async () => {
    // The failure this pins is a one-word slip - emitting the level-1
    // referrer where the walk result belongs - and it is invisible in a
    // chain where the two happen to be the same person, so they are not.
    const { service } = probe({ rows: [REGISTRATION], ancestors: [A_REFERRED_B] });

    const rows = await service.listReferrals({});

    const levelTwo = rows.find((row) => row.level === 2);
    assert.ok(levelTwo, 'the chain funds level 2, so the row must exist');
    assert.equal(levelTwo.referrer.id, 'a');
    assert.notEqual(levelTwo.referrer.id, 'b');
    assert.equal(levelTwo.referrer.displayName, 'a-name');
  });

  it('gives the derived row an id that cannot be mistaken for a database row', async () => {
    const { service } = probe({ rows: [REGISTRATION], ancestors: [A_REFERRED_B] });

    const rows = await service.listReferrals({});

    assert.equal(rows[1].id, deriveLevel2RowId('edge-c'));
    assert.equal(rows[1].id, 'derived:L2:edge-c');
    assert.ok(rows[1].id.startsWith(DERIVED_LEVEL_2_ID_PREFIX));
    // Distinct from its own level-1 row, and from every other row - React
    // keys and any future row action depend on both.
    assert.notEqual(rows[1].id, rows[0].id);
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  });

  it('emits the same derived id on a second call, so React keys survive a refetch', async () => {
    const { service } = probe({ rows: [REGISTRATION], ancestors: [A_REFERRED_B] });

    const first = await service.listReferrals({});
    const second = await service.listReferrals({});

    assert.deepStrictEqual(
      first.map((row) => row.id),
      second.map((row) => row.id),
    );
  });

  // -- The gates, each read off `createConfiguredRewards` --------------------

  it('emits NO level-2 row when level 2 pays 0 - it is not configured', async () => {
    // `if (secondAmount <= 0) return created;` - the engine returns before the
    // walk, so no level-2 reward is ever created for this chain.
    const { service } = probe({
      rows: [REGISTRATION],
      ancestors: [A_REFERRED_B],
      referralSettings: { rewardType: 'POINTS', level1Reward: 100, level2Reward: 0 },
    });

    const rows = await service.listReferrals({});

    assert.deepStrictEqual(payoutShape(rows), [[1, 'b', null]]);
    // Stated as an absence, not merely implied by the length above: A must
    // not appear anywhere, at any level.
    assert.equal(
      rows.some((row) => row.level === 2),
      false,
    );
    assert.equal(
      rows.some((row) => row.referrer.id === 'a'),
      false,
    );
  });

  it('emits NO level-2 row when level 2 is unset rather than zero', async () => {
    const { service } = probe({
      rows: [REGISTRATION],
      ancestors: [A_REFERRED_B],
      referralSettings: { rewardType: 'POINTS', level1Reward: 100 },
    });

    const rows = await service.listReferrals({});

    assert.deepStrictEqual(payoutShape(rows), [[1, 'b', null]]);
  });

  it('reads level 2 through the legacy nested shape as well as the form shape', async () => {
    // `normalizeReferralSettings` bridges both spellings and the engine reads
    // the bridged value. A private copy of that read here would disagree with
    // it on exactly the installs that still hold the old shape.
    const { service } = probe({
      rows: [REGISTRATION],
      ancestors: [A_REFERRED_B],
      referralSettings: {
        reward: { type: 'POINTS', strategy: 'AMOUNT', config: { FIRST: 100, SECOND: 50 } },
      },
    });

    const rows = await service.listReferrals({});

    assert.deepStrictEqual(payoutShape(rows), [
      [1, 'b', null],
      [2, 'a', null],
    ]);
  });

  it('emits NO level-2 row when the grandparent is an ACTIVE partner', async () => {
    // `if (l2Partner?.isActive === true) return created;` - the partner
    // engine pays A out of a different pot, so the referral programme does not.
    const { service } = probe({
      rows: [REGISTRATION],
      ancestors: [A_REFERRED_B],
      partners: [{ userId: 'a', isActive: true }],
    });

    const rows = await service.listReferrals({});

    assert.deepStrictEqual(payoutShape(rows), [[1, 'b', null]]);
    assert.equal(
      rows.some((row) => row.referrer.id === 'a'),
      false,
    );
  });

  it('still pays a grandparent whose partner record is INACTIVE', async () => {
    // The engine asks `isActive === true`, not "has a partner row". This is
    // also what proves the batched lookup carries `isActive: true`: a where
    // clause that dropped it would hand back this row and delete the payout.
    const { service } = probe({
      rows: [REGISTRATION],
      ancestors: [A_REFERRED_B],
      partners: [{ userId: 'a', isActive: false }],
    });

    const rows = await service.listReferrals({});

    assert.deepStrictEqual(payoutShape(rows), [
      [1, 'b', null],
      [2, 'a', null],
    ]);
  });

  it('emits one row when the referrer was never referred by anyone', async () => {
    // `if (!l2Referral) return created;` - B has no referrer, so the walk
    // stops. The ordinary case, not a defect.
    const { service } = probe({ rows: [REGISTRATION], ancestors: [] });

    const rows = await service.listReferrals({});

    assert.deepStrictEqual(payoutShape(rows), [[1, 'b', null]]);
  });

  // -- The level-1 referrer who is a partner ---------------------------------
  //
  // THE DECISION, pinned. `createConfiguredRewards` checks B FIRST and
  // `return 0`s - B is paid by the partner engine instead. The row is a real
  // database row describing a real relationship, so deleting it would hide a
  // fact the operator needs. It is kept, and marked: `payoutBlockedBy` names
  // the programme that takes over. Unmarked, the row would promise a payout
  // that never moves - the thing this whole change exists to stop.

  it('keeps the level-1 row when its referrer is an active partner, and says who pays', async () => {
    const { service } = probe({
      rows: [REGISTRATION],
      ancestors: [A_REFERRED_B],
      partners: [{ userId: 'b', isActive: true }],
    });

    const rows = await service.listReferrals({});

    assert.deepStrictEqual(payoutShape(rows), [[1, 'b', 'PARTNER_PROGRAMME']]);
    // The relationship stays fully visible - both people, and the invitee.
    assert.equal(rows[0].referrer.displayName, 'b-name');
    assert.equal(rows[0].referred.id, 'c');
  });

  it('emits NO level-2 row when the LEVEL-1 referrer is an active partner', async () => {
    // Easy to miss and expensive to get wrong: the partner check on B sits
    // ABOVE the `SECOND` read, so `return 0` there kills the level-2 reward
    // for A too. Level 2 is fully funded here and must still produce nothing.
    const { service } = probe({
      rows: [REGISTRATION],
      ancestors: [A_REFERRED_B],
      partners: [{ userId: 'b', isActive: true }],
    });

    const rows = await service.listReferrals({});

    assert.equal(
      rows.some((row) => row.level === 2),
      false,
    );
    assert.equal(
      rows.some((row) => row.referrer.id === 'a'),
      false,
    );
  });

  it('marks a level-1 row that pays nothing because no reward is configured', async () => {
    const { service } = probe({
      rows: [REGISTRATION],
      ancestors: [A_REFERRED_B],
      referralSettings: { rewardType: 'POINTS', level1Reward: 0, level2Reward: 50 },
    });

    const rows = await service.listReferrals({});

    // Level 1 pays nothing and says so; level 2 is funded, so A is still paid.
    assert.deepStrictEqual(payoutShape(rows), [
      [1, 'b', 'REWARD_NOT_CONFIGURED'],
      [2, 'a', null],
    ]);
  });

  it('marks every level-1 row and drops every level-2 row when the programme is off', async () => {
    // `qualifyReferralAfterPurchase` returns on `enabled === false` before it
    // ever reaches `createConfiguredRewards`, so nothing at any level pays.
    const { service } = probe({
      rows: [REGISTRATION],
      ancestors: [A_REFERRED_B],
      referralSettings: {
        enabled: false,
        rewardType: 'POINTS',
        level1Reward: 100,
        level2Reward: 50,
      },
    });

    const rows = await service.listReferrals({});

    assert.deepStrictEqual(payoutShape(rows), [[1, 'b', 'REWARD_NOT_CONFIGURED']]);
  });

  it('treats an absent enabled flag as enabled, the way the engine does', async () => {
    const { service } = probe({ rows: [REGISTRATION], ancestors: [A_REFERRED_B] });

    const rows = await service.listReferrals({});

    assert.deepStrictEqual(payoutShape(rows), [
      [1, 'b', null],
      [2, 'a', null],
    ]);
  });

  // -- Batching --------------------------------------------------------------

  it('issues the same four queries for fifty registrations as for one', async () => {
    const one = probe({ rows: [REGISTRATION], ancestors: [A_REFERRED_B] });
    await one.service.listReferrals({});

    const many = probe({
      rows: Array.from({ length: 50 }, (_unused, index) =>
        registration({
          id: `edge-${index}`,
          referrerId: `child-${index}`,
          referredId: `grandchild-${index}`,
        }),
      ),
      ancestors: Array.from({ length: 50 }, (_unused, index) => ({
        referredId: `child-${index}`,
        referrerId: `root-${index}`,
      })),
    });
    const rows = await many.service.listReferrals({});

    // The rows really did scale - otherwise "the query count did not" would be
    // true because nothing happened.
    assert.equal(rows.length, 100);
    assert.deepStrictEqual(many.calls, one.calls);
    assert.deepStrictEqual(many.calls, [
      'referral.findMany(page)',
      'settings.findFirst',
      'referral.findMany(ancestors)',
      'partner.findMany',
    ]);
    // And the two batched lookups asked ONE question each, covering everyone.
    assert.equal(many.ancestorWheres.length, 1);
    assert.equal(many.partnerWheres.length, 1);
    assert.equal(
      (many.ancestorWheres[0] as { referredId: { in: readonly string[] } }).referredId.in.length,
      50,
    );
    assert.equal(
      (many.partnerWheres[0] as { userId: { in: readonly string[] } }).userId.in.length,
      100,
    );
  });

  it('skips the ancestor query entirely when level 2 is not configured', async () => {
    const { service, calls } = probe({
      rows: [REGISTRATION],
      ancestors: [A_REFERRED_B],
      referralSettings: { rewardType: 'POINTS', level1Reward: 100, level2Reward: 0 },
    });

    await service.listReferrals({});

    assert.deepStrictEqual(calls, [
      'referral.findMany(page)',
      'settings.findFirst',
      'partner.findMany',
    ]);
  });

  it('asks nothing further when the page is empty', async () => {
    const { service, calls } = probe({ rows: [], ancestors: [A_REFERRED_B] });

    const rows = await service.listReferrals({});

    assert.deepStrictEqual(rows, []);
    assert.deepStrictEqual(calls, ['referral.findMany(page)', 'settings.findFirst']);
  });

  // -- What the query filters mean now ---------------------------------------

  it('pages REGISTRATIONS, so a page of one edge can carry two rows', async () => {
    let pageArgs: unknown;
    const { service } = probe({
      rows: [REGISTRATION],
      ancestors: [A_REFERRED_B],
      onPageArgs: (args) => {
        pageArgs = args;
      },
    });

    const rows = await service.listReferrals({ limit: 1, offset: 7 });

    // `limit` reaches Prisma untouched: it budgets the edges the page steps
    // over, which is the only reading that keeps `offset` meaning anything.
    assert.equal((pageArgs as { take: number }).take, 1);
    assert.equal((pageArgs as { skip: number }).skip, 7);
    assert.equal(rows.length, 2);
  });

  it('returns only rows the filtered user EARNS when referrerId is set', async () => {
    // The page for B. The derived row on it belongs to A, so it is not B to
    // see here - the filter returns exactly the set it returned before derived
    // rows existed, and every row still satisfies `referrer.id === b`.
    const { service } = probe({ rows: [REGISTRATION], ancestors: [A_REFERRED_B] });

    const rows = await service.listReferrals({ referrerId: 'b' });

    assert.deepStrictEqual(payoutShape(rows), [[1, 'b', null]]);
    assert.deepStrictEqual(
      rows.map((row) => row.referrer.id),
      ['b'],
    );
  });

  it('answers referredId with everyone who earns from that registration', async () => {
    // The derived row describes the SAME invitee, so it belongs on this page -
    // this is the filter the two-row table was built for.
    const { service } = probe({ rows: [REGISTRATION], ancestors: [A_REFERRED_B] });

    const rows = await service.listReferrals({ referredId: 'c' });

    assert.deepStrictEqual(payoutShape(rows), [
      [1, 'b', null],
      [2, 'a', null],
    ]);
    assert.deepStrictEqual(
      rows.map((row) => row.referred.id),
      ['c', 'c'],
    );
  });

  it('keeps the two rows of one registration adjacent, level 1 first', async () => {
    const older = registration({
      id: 'edge-old',
      referrerId: 'b',
      referredId: 'c',
      createdAt: daysAgo(9),
    });
    const newer = registration({
      id: 'edge-new',
      referrerId: 'e',
      referredId: 'f',
      createdAt: daysAgo(2),
    });
    const { service } = probe({
      // Newest first, as the page own orderBy delivers them.
      rows: [newer, older],
      ancestors: [A_REFERRED_B, { referredId: 'e', referrerId: 'd' }],
    });

    const rows = await service.listReferrals({});

    assert.deepStrictEqual(
      rows.map((row) => [row.id, row.level]),
      [
        ['edge-new', 1],
        ['derived:L2:edge-new', 2],
        ['edge-old', 1],
        ['derived:L2:edge-old', 2],
      ],
    );
  });
});
