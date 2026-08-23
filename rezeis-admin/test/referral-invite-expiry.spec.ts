import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';

import { CreateReferralInviteDto } from '../src/modules/referrals/dto/create-referral-invite.dto';
import {
  MIN_LINK_TTL_SECONDS,
  ReferralInviteLimitsService,
} from '../src/modules/referrals/services/referral-invite-limits.service';
import { ReferralsService } from '../src/modules/referrals/services/referrals.service';

/**
 * `expiresInDays: null` used to be ACCEPTED end to end and produce an invite
 * that was already expired at the instant it was created:
 *
 *   `@IsOptional()` skips `null` as well as `undefined`, so validation passed;
 *   `resolveInviteExpiry` then took its `!== undefined` branch and called
 *   `addDays(new Date(), null)`, and `setUTCDate(getUTCDate() + null)` is a
 *   no-op - so `expiresAt` came back as the creation instant itself. Nothing
 *   downstream re-checks it: the live-invite filters only ask
 *   `expiresAt: null OR gt: now`, and an invite stamped `now` fails that
 *   immediately. No error was raised anywhere.
 *
 * Both halves are pinned, because they protect DIFFERENT callers: the DTO
 * covers the admin HTTP route, and the service guard covers
 * `InternalReferralsController.createInvite`, which builds this input in
 * TypeScript and never meets a ValidationPipe at all.
 */

const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

const metadata: ArgumentMetadata = {
  type: 'body',
  metatype: CreateReferralInviteDto,
  data: undefined,
};

function validate(raw: Record<string, unknown>): Promise<unknown> {
  return pipe.transform(raw, metadata);
}

// Every instant in this file is derived from the clock the test holds, never
// from a literal. This file is entirely about `expiresAt`, and a `2026-03-01`
// fixture is a live "in the future" assertion on the morning it is typed and an
// "already expired" one some months later, with nothing turning red in between.
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The invite lifetime THE OPERATOR CONFIGURED, as
 * `ReferralInviteLimitsService.resolveInviteExpiry` answers it.
 *
 * NINE days on purpose. The window this service used to hardcode was THIRTY, so
 * a 30-day fixture would make "the operator's setting was applied" and "the
 * setting was ignored and the old default applied" the same assertion - the
 * vacuity that let the defect below sit under a green test.
 */
const OPERATOR_EXPIRY = new Date(NOW + 9 * DAY_MS + 4_321);

/**
 * The two questions `ReferralsService.createInvite` asks the limits service,
 * plus a log of WHO each expiry question was asked about.
 *
 * `getCapacity` is the invite QUOTA - the admin route used to write a row
 * without asking at all - and answers "there is room" here so that cases about
 * expiry are not also cases about the quota; the quota's own behaviour is
 * pinned in `referral-invite-admin-quota.spec.ts`.
 *
 * `resolveInviteExpiry` is the OPERATOR'S TTL, and it is what this file is
 * about. Supplied rather than left undefined for the same reason as the quota:
 * an absent collaborator fails these with a TypeError that looks nothing like
 * the behaviour they pin.
 */
function inviteLimitsWith(operatorExpiry: Date | null, expiryAskedAbout: string[]): never {
  return {
    getCapacity: async (): Promise<unknown> => ({
      totalSlots: 5,
      usedSlots: 1,
      remainingSlots: 4,
      canCreateInvite: true,
    }),
    resolveInviteExpiry: async (userId: string): Promise<Date | null> => {
      expiryAskedAbout.push(userId);
      return operatorExpiry;
    },
  } as never;
}

/**
 * The pipe returns a CLASS INSTANCE, and `assert/strict`'s `deepEqual` compares
 * prototypes - so spread it to a plain object before comparing shape.
 */
async function validatedFields(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dto = (await validate(raw)) as Record<string, unknown>;
  return { ...dto };
}

function inviterRecord(id: string): Record<string, unknown> {
  return {
    id,
    username: `${id}-username`,
    name: `${id}-name`,
    telegramId: BigInt('123456789'),
    createdAt: new Date(NOW - 120 * DAY_MS),
  };
}

/** Captures the `expiresAt` the service would actually persist. */
function buildService(operatorExpiry: Date | null = OPERATOR_EXPIRY): {
  service: ReferralsService;
  written: () => Date | null | undefined;
  expiryAskedAbout: readonly string[];
} {
  let createArgs: unknown;
  const expiryAskedAbout: string[] = [];
  const service = new ReferralsService({
    user: { findUnique: async (): Promise<unknown> => ({ id: 'inviter-1' }) },
    referralInvite: {
      create: async (args: unknown): Promise<unknown> => {
        createArgs = args;
        const data = (args as { data: { expiresAt: Date | null } }).data;
        return {
          id: 'invite-1',
          token: 'generated-token',
          inviter: inviterRecord('inviter-1'),
          note: null,
          expiresAt: data.expiresAt,
          revokedAt: null,
          consumedAt: null,
          createdAt: new Date(NOW - 120 * DAY_MS),
        };
      },
    },
  } as never, inviteLimitsWith(operatorExpiry, expiryAskedAbout));
  return {
    service,
    written: (): Date | null | undefined =>
      (createArgs as { data: { expiresAt: Date | null } } | undefined)?.data.expiresAt,
    expiryAskedAbout,
  };
}

describe('CreateReferralInviteDto expiresInDays validation', () => {
  it('refuses expiresInDays: null instead of accepting it', async () => {
    await assert.rejects(
      () => validate({ inviterId: 'user-1', expiresInDays: null }),
      (error: unknown) => {
        const response = (error as { getResponse: () => { message?: unknown } }).getResponse();
        const messages = Array.isArray(response.message) ? response.message : [];
        assert.ok(
          messages.some((entry: string) => entry.includes('expiresInDays')),
          `expected an expiresInDays constraint, got ${JSON.stringify(response.message)}`,
        );
        return true;
      },
    );
  });

  it('still accepts a real day count', async () => {
    assert.deepEqual(await validatedFields({ inviterId: 'user-1', expiresInDays: 7 }), {
      inviterId: 'user-1',
      expiresInDays: 7,
    });
  });

  it("still accepts an absent field, which defers to the operator's configuration", async () => {
    assert.deepEqual(await validatedFields({ inviterId: 'user-1' }), { inviterId: 'user-1' });
  });

  it('leaves expiresAt: null alone - it is the one spelling of "never expires"', async () => {
    assert.deepEqual(await validatedFields({ inviterId: 'user-1', expiresAt: null }), {
      inviterId: 'user-1',
      expiresAt: null,
    });
  });
});

describe('ReferralsService invite expiry resolution', () => {
  it('refuses a null TTL from the internal path, which bypasses the pipe', async () => {
    const { service, written } = buildService();

    await assert.rejects(
      // Exactly what an internal caller writing `value ?? null` would pass.
      () => service.createInvite({ inviterId: 'inviter-1', expiresInDays: null as never }),
      BadRequestException,
    );
    assert.equal(written(), undefined, 'no invite may be written at all');
  });

  it('does not write an invite that expires at its own creation instant', async () => {
    const before = Date.now();
    const { service, written, expiryAskedAbout } = buildService();

    await service.createInvite({ inviterId: 'inviter-1', expiresInDays: 7 });

    const expiresAt = written();
    assert.ok(expiresAt instanceof Date);
    assert.ok(
      expiresAt.getTime() >= before + 7 * DAY_MS,
      `expected roughly 7 days out, got ${expiresAt.toISOString()}`,
    );
    // BOUNDED ABOVE as well. The lower bound alone is satisfied by the
    // operator's own answer (nine days), so a service that dropped the
    // requested day count and fell through to the configured default would
    // have passed this case - and did, until this bound was added.
    assert.ok(
      expiresAt.getTime() <= Date.now() + 7 * DAY_MS,
      `expected the REQUESTED 7 days, not the configured default: ${expiresAt.toISOString()}`,
    );
    assert.deepStrictEqual([...expiryAskedAbout], []);
  });

  it('refuses an unparseable expiresAt instead of handing Prisma an Invalid Date', async () => {
    const { service, written } = buildService();

    await assert.rejects(
      () => service.createInvite({ inviterId: 'inviter-1', expiresAt: 'not-a-date' }),
      BadRequestException,
    );
    assert.equal(written(), undefined);
  });

  /**
   * This was a characterisation test pinning "a past expiresAt is accepted",
   * because refusing would have fired on the bot route: it arrives with
   * `now + linkTtlSeconds`, and that had no lower bound (per-user DTO allowed
   * `@Min(0)`; the global value was raw JSON accepting negatives).
   *
   * `linkTtlSeconds` is now floored at `MIN_LINK_TTL_SECONDS` in both places,
   * so the margin is a minute rather than zero and the guard can be strict.
   */
  it('refuses a past expiresAt, which minted a dead-on-arrival invite', async () => {
    const { service, written } = buildService();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    await assert.rejects(
      () => service.createInvite({ inviterId: 'inviter-1', expiresAt: yesterday.toISOString() }),
      BadRequestException,
    );
    assert.equal(written(), undefined, 'no invite may be written at all');
  });

  it('refuses an expiresAt of a moment ago, not only an obviously old one', async () => {
    const { service } = buildService();

    await assert.rejects(
      () =>
        service.createInvite({
          inviterId: 'inviter-1',
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      BadRequestException,
    );
  });

  /**
   * ANTI-VACUITY CONTROL. A floor that also rejects good values would be its
   * own outage, so a legitimate short-but-valid window must still work. One
   * minute is exactly `MIN_LINK_TTL_SECONDS` - the shortest TTL the bot route
   * can now produce, and therefore the tightest case the guard has to accept.
   */
  it('accepts the shortest expiry the bot route can now produce', async () => {
    const { service, written } = buildService();
    const soon = new Date(Date.now() + MIN_LINK_TTL_SECONDS * 1000);

    await service.createInvite({ inviterId: 'inviter-1', expiresAt: soon.toISOString() });

    assert.deepEqual(written(), soon);
  });

  it('refuses a day count that walks Date past its representable range', async () => {
    const { service } = buildService();

    await assert.rejects(
      () => service.createInvite({ inviterId: 'inviter-1', expiresInDays: 1e12 }),
      BadRequestException,
    );
  });

  it('still honours expiresAt: null as a permanent invite', async () => {
    const { service, written } = buildService();

    const result = await service.createInvite({ inviterId: 'inviter-1', expiresAt: null });

    assert.equal(written(), null);
    assert.equal(result.invite.expiresAt, null);
  });

  /**
   * WHAT THIS CASE USED TO GUARD, AND WHAT IT GUARDS NOW.
   *
   * It read `expiresAt.getTime() > Date.now() + 29 days` - i.e. it PINNED the
   * hardcoded `DEFAULT_INVITE_TTL_DAYS = 30` as the expected behaviour for
   * exactly the call shape both panel surfaces send: a body with no expiry
   * field at all. That is the defect, written down as the contract. An operator
   * who switched link expiry off, or who granted a user the VIP bypass, still
   * got 30-day links from the panel while the bot minted permanent ones - and
   * this assertion said that was correct.
   *
   * It now guards the opposite, and something stricter than "not 30": that
   * `createInvite` writes the EXACT instant `ReferralInviteLimitsService`
   * answered with, and asks it about the inviter NAMED IN THE REQUEST. A
   * service that re-derived a window of its own - 30 days or any other - would
   * still produce "a Date in the future" and still satisfy the old assertion,
   * so the identity comparison is the whole point. What the limits service in
   * turn computes from the operator's stored configuration is pinned end to end
   * in the final describe of this file.
   */
  it("writes the exact expiry the operator's configuration resolved to", async () => {
    const { service, written, expiryAskedAbout } = buildService();

    await service.createInvite({ inviterId: 'inviter-1' });

    assert.deepStrictEqual(written(), OPERATOR_EXPIRY);
    assert.deepStrictEqual([...expiryAskedAbout], ['inviter-1']);
    // Belt and braces on the specific answer that used to stand here: the old
    // 30-day window is ruled out by the clock as well as by identity.
    assert.ok(
      (written() as Date).getTime() < NOW + 29 * DAY_MS,
      'a window near 30 days means the hardcoded default came back',
    );
  });

  it('writes no expiry at all when the operator configured none', async () => {
    // `null` is `resolveInviteExpiry`'s answer for `linkTtlEnabled: false` and
    // for a user holding `bypassInviteGate`. It must reach the row unchanged,
    // and must NOT be re-read as "the request said nothing, apply a default".
    const { service, written, expiryAskedAbout } = buildService(null);

    await service.createInvite({ inviterId: 'inviter-1' });

    assert.strictEqual(written(), null);
    assert.deepStrictEqual([...expiryAskedAbout], ['inviter-1']);
  });
});

/**
 * THE OPERATOR CONFIGURED IT ONCE; THE PANEL USED TO IGNORE IT.
 *
 * Above, the limits service is a fake, so those cases pin the COMPOSITION -
 * that the write site asks and writes what it is told. This describe runs the
 * real `ReferralInviteLimitsService` over the real
 * `Settings.referralSettings.inviteLimits` JSON and the real
 * `User.referralInviteSettings` override, so it pins the whole chain the defect
 * lived in: operator setting -> limits service -> `ReferralsService` -> the
 * `expiresAt` column.
 *
 * The defect: `POST /admin/referrals/invites` arrives with NO expiry field -
 * neither panel surface sends one - and the service fell through to a
 * module-local `resolveInviteExpiry` ending in a hardcoded 30-day window that
 * consulted no configuration at all. The bot path pre-resolved its own expiry
 * and passed it in, so the same install minted permanent links from the bot and
 * 30-day links from the panel.
 *
 * NOTE what these cases do NOT assert: they say nothing about
 * `findReusableInvite` or the invited-only gate. The admin route skips both on
 * purpose - those are eligibility rules ABOUT THE USER that an operator route
 * exists to overrule. The TTL is not a rule about the user, it is the
 * operator's own setting, which is why it converged and they must not.
 */

interface OperatorConfig {
  /** `Settings.referralSettings.inviteLimits`, or `null` for an install with none. */
  readonly globalInviteLimits: Record<string, unknown> | null;
  /** `User.referralInviteSettings` for the inviter. */
  readonly userOverride?: Record<string, unknown> | null;
}

interface AdminWriteSite {
  readonly createInvite: (dto: CreateReferralInviteDto) => Promise<unknown>;
  /** One entry per `referralInvite.create`, exactly as Prisma received it. */
  readonly writes: readonly { readonly data: Record<string, unknown> }[];
  /** One entry per `resolveInviteExpiry`, carrying the user id it was asked about. */
  readonly expiryAskedAbout: readonly string[];
}

/**
 * `ReferralsService` wired to a REAL `ReferralInviteLimitsService`, both over
 * one fake Prisma holding the operator's configuration.
 *
 * `resolveInviteExpiry` is wrapped rather than replaced: the real computation
 * still runs, and the wrapper only records the argument. A replacement would
 * make every case below a test of the fake.
 */
function adminWriteSite(config: OperatorConfig): AdminWriteSite {
  const writes: { data: Record<string, unknown> }[] = [];
  const expiryAskedAbout: string[] = [];
  const prisma = {
    settings: {
      findFirst: async (): Promise<unknown> =>
        config.globalInviteLimits === null
          ? { referralSettings: {} }
          : { referralSettings: { inviteLimits: config.globalInviteLimits } },
    },
    user: {
      // The limits service selects `referralInviteSettings`; `createInvite`
      // selects `id` to check the inviter exists. One table, two questions.
      findUnique: async (args: { select?: Record<string, unknown> }): Promise<unknown> =>
        args.select !== undefined && 'referralInviteSettings' in args.select
          ? { referralInviteSettings: config.userOverride ?? null }
          : { id: 'inviter-1' },
    },
    referralInvite: {
      // Only reached when the operator switched SLOTS on; these fixtures leave
      // slots off, so the quota answers "unlimited" without counting. Supplied
      // anyway so a change that starts counting fails on an assertion rather
      // than on a TypeError.
      count: async (): Promise<number> => 0,
      create: async (args: { data: Record<string, unknown> }): Promise<unknown> => {
        writes.push(args);
        return {
          id: `invite-${writes.length}`,
          token: args.data.token,
          inviter: inviterRecord(args.data.inviterId as string),
          note: args.data.note ?? null,
          expiresAt: args.data.expiresAt ?? null,
          revokedAt: null,
          consumedAt: null,
          createdAt: new Date(NOW),
        };
      },
    },
    referral: { count: async (): Promise<number> => 0 },
  };

  const limitsService = new ReferralInviteLimitsService(prisma as never);
  const realResolve = limitsService.resolveInviteExpiry.bind(limitsService);
  (
    limitsService as unknown as {
      resolveInviteExpiry: (userId: string, explicit?: Date | null) => Promise<Date | null>;
    }
  ).resolveInviteExpiry = async (userId, explicit): Promise<Date | null> => {
    expiryAskedAbout.push(userId);
    return realResolve(userId, explicit);
  };

  const service = new ReferralsService(prisma as never, limitsService);
  return {
    createInvite: (dto: CreateReferralInviteDto): Promise<unknown> => service.createInvite(dto),
    writes,
    expiryAskedAbout,
  };
}

/** The `expiresAt` column of the single row a case wrote. */
function writtenExpiry(site: AdminWriteSite): Date | null {
  assert.equal(site.writes.length, 1, 'expected exactly one ReferralInvite row');
  return site.writes[0].data.expiresAt as Date | null;
}

describe("the admin route mints on the operator's configured lifetime", () => {
  it('writes no expiry when the operator switched link expiry off', async () => {
    // THE HEADLINE CASE. `linkTtlEnabled: false` used to produce a permanent
    // link from the bot and a 30-day link from the panel.
    const site = adminWriteSite({
      globalInviteLimits: { linkTtlEnabled: false, linkTtlSeconds: 86400 },
    });

    await site.createInvite({ inviterId: 'inviter-1' });

    assert.strictEqual(
      writtenExpiry(site),
      null,
      'link expiry is switched off, so the panel must mint a link that never expires',
    );
    assert.deepStrictEqual([...site.expiryAskedAbout], ['inviter-1']);
  });

  it('writes the globally configured window when the operator set one', async () => {
    const before = Date.now();
    const site = adminWriteSite({
      globalInviteLimits: { linkTtlEnabled: true, linkTtlSeconds: 7 * 24 * 60 * 60 },
    });

    await site.createInvite({ inviterId: 'inviter-1' });

    const written = writtenExpiry(site);
    assert.ok(written instanceof Date, 'a configured TTL must produce a date');
    // Bounded on both sides by the clock this test holds - never a literal.
    assert.ok(written.getTime() >= before + 7 * DAY_MS);
    assert.ok(written.getTime() <= Date.now() + 7 * DAY_MS);
    assert.ok(
      written.getTime() < before + 8 * DAY_MS,
      `expected the operator's 7 days, got ${written.toISOString()}`,
    );
  });

  it('lets a per-user override decide, from the panel too', async () => {
    // The global here is THIRTY days on purpose: it is exactly the window the
    // panel used to hardcode, so "the override applied" and "the old default
    // applied" cannot be the same assertion.
    const before = Date.now();
    const site = adminWriteSite({
      globalInviteLimits: { linkTtlEnabled: true, linkTtlSeconds: 30 * 24 * 60 * 60 },
      userOverride: { linkTtlEnabled: true, linkTtlSeconds: 3 * 24 * 60 * 60 },
    });

    await site.createInvite({ inviterId: 'inviter-1' });

    const written = writtenExpiry(site);
    assert.ok(written instanceof Date);
    assert.ok(written.getTime() >= before + 3 * DAY_MS);
    assert.ok(
      written.getTime() < before + 4 * DAY_MS,
      `expected the per-user 3 days, not the global 30: got ${written.toISOString()}`,
    );
  });

  it('gives a VIP holding bypassInviteGate a permanent link, not a dated one', async () => {
    // The bypass is read independently of `useGlobalSettings`, so an override
    // carrying only the flag still waives a TTL that is switched ON globally.
    const site = adminWriteSite({
      globalInviteLimits: { linkTtlEnabled: true, linkTtlSeconds: 86400 },
      userOverride: { bypassInviteGate: true },
    });

    await site.createInvite({ inviterId: 'inviter-1' });

    assert.strictEqual(writtenExpiry(site), null);
  });

  it('still lets an explicit expiresInDays overrule the operator default', async () => {
    // An operator who wants a different lifetime for ONE invite still says so.
    // Only the default changed. The configuration here says "never expires", so
    // a dated row can only have come from the request.
    const before = Date.now();
    const site = adminWriteSite({
      globalInviteLimits: { linkTtlEnabled: false, linkTtlSeconds: null },
    });

    await site.createInvite({ inviterId: 'inviter-1', expiresInDays: 5 });

    const written = site.writes[0].data.expiresAt as Date | null;
    assert.ok(written instanceof Date, 'an explicit window must beat a configured "never expires"');
    assert.ok(written.getTime() >= before + 5 * DAY_MS);
    assert.ok(written.getTime() <= Date.now() + 5 * DAY_MS);

    // THE ABSENCE: the configuration is not consulted at all on this path...
    assert.deepStrictEqual([...site.expiryAskedAbout], []);
    // ...and its INERTNESS CONTROL, on the SAME recorder and the same site: a
    // request that says nothing does reach it, so the empty log above is a real
    // zero rather than a recorder that never records.
    await site.createInvite({ inviterId: 'inviter-2' });
    assert.deepStrictEqual([...site.expiryAskedAbout], ['inviter-2']);
    assert.strictEqual(site.writes[1].data.expiresAt, null);
  });

  it('still lets an explicit expiresAt: null overrule a configured window', async () => {
    // This is the shape the BOT route sends, and it is why that path pays no
    // second query: it arrives explicit, so the composition never reaches the
    // limits service twice.
    const site = adminWriteSite({
      globalInviteLimits: { linkTtlEnabled: true, linkTtlSeconds: 86400 },
    });

    await site.createInvite({ inviterId: 'inviter-1', expiresAt: null });

    assert.strictEqual(writtenExpiry(site), null);
    assert.deepStrictEqual([...site.expiryAskedAbout], []);
  });

  it('writes no expiry on an install that has no invite-limits configuration at all', async () => {
    // A fresh install: `Settings.referralSettings` is `{}`. `DEFAULT_LIMITS` has
    // `linkTtlEnabled: false`, so the honest answer is "no expiry" - not the
    // 30-day window the panel used to invent for exactly this install.
    const site = adminWriteSite({ globalInviteLimits: null });

    await site.createInvite({ inviterId: 'inviter-1' });

    assert.strictEqual(writtenExpiry(site), null);
  });
});
