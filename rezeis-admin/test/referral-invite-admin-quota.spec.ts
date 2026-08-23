import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentsHost, BadRequestException, NotFoundException } from '@nestjs/common';

import {
  AdminSafeExceptionFilter,
  SAFE_PRODUCT_CODES,
} from '../src/common/filters/admin-safe-exception.filter';
import {
  INVITE_SLOT_LIMIT_REACHED_CODE,
  INVITE_SLOT_LIMIT_REACHED_MESSAGE,
  ReferralsService,
} from '../src/modules/referrals/services/referrals.service';

/**
 * THE ADMIN INVITE ROUTE DID NOT ASK ABOUT THE QUOTA.
 *
 * The operator configures a per-user invite quota;
 * `ReferralInviteLimitsService.getCapacity` computes whether it is spent, and
 * `validateCanCreateInvite` is that call plus a throw. Its ONLY caller was
 * `InternalReferralsController.createInvite` - the bot / subscriber path. The
 * admin route `POST /admin/referrals/invites` goes through
 * `ReferralsService.createInvite`, which checked that the inviter EXISTED and
 * then wrote the row: an over-quota invite created from the panel succeeded and
 * handed out a slot the operator's own configuration says does not exist.
 *
 * -- WHAT THESE CASES ASSERT ON ----------------------------------------------
 *
 * The ROWS, and the arguments Prisma was handed - never a spy's call count. A
 * count is satisfied by a create that wrote the wrong thing, and "the quota was
 * consulted" is satisfied by a consultation whose answer was ignored. The
 * refusal cases therefore assert that the write log is EMPTY, and
 * `control: the fake records a row for every create` proves that log is a real
 * zero rather than a stub that never writes at all.
 *
 * -- NO ABSOLUTE DATES -------------------------------------------------------
 *
 * Invites carry `expiresAt`, `revokedAt` and `consumedAt`, so a literal like
 * `2026-03-01` in a fixture here is a live assertion on the morning it is typed
 * and an "already expired" assertion some months later, with nothing turning
 * red in between. Every instant below is derived from `NOW`.
 */
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

/** Every column `REFERRAL_USER_SUMMARY_SELECT` asks for, so the mapper has real input. */
function inviterRecord(id: string): Record<string, unknown> {
  return {
    id,
    username: `${id}-username`,
    name: `${id}-name`,
    telegramId: BigInt('123456789'),
    email: `${id}@example.test`,
    webAccount: { login: `${id}-login`, email: `${id}-wa@example.test` },
    createdAt: new Date(NOW - 120 * DAY_MS),
  };
}

interface CapacityAnswer {
  readonly totalSlots: number | null;
  readonly usedSlots: number;
  readonly remainingSlots: number | null;
  readonly canCreateInvite: boolean;
}

/** A quota with room to spare. */
const HAS_ROOM: CapacityAnswer = {
  totalSlots: 5,
  usedSlots: 1,
  remainingSlots: 4,
  canCreateInvite: true,
};

/** Every slot in use - the case the admin route used to ignore. */
const SPENT: CapacityAnswer = {
  totalSlots: 3,
  usedSlots: 3,
  remainingSlots: 0,
  canCreateInvite: false,
};

/**
 * THE VIP BYPASS, AND THE ONE ANSWER THAT MUST NOT BE READ AS A NUMBER.
 *
 * `getCapacity` returns this shape for a user holding `bypassInviteGate`, for a
 * user whose slot config is switched off, and for one whose `initialSlots` is
 * `null`. `null` means UNLIMITED. Any reader that coerces it - `?? 0`,
 * `Number(...)`, `> 0` - turns "no limit applies" into "no slots left" and locks
 * out precisely the users the exemption exists for.
 */
const UNLIMITED: CapacityAnswer = {
  totalSlots: null,
  usedSlots: 0,
  remainingSlots: null,
  canCreateInvite: true,
};

/**
 * The invite lifetime THE OPERATOR CONFIGURED, as
 * `ReferralInviteLimitsService.resolveInviteExpiry` answers it.
 *
 * `createInvite` now resolves the TTL at the write site as well as the quota,
 * so the fake limits service below has to answer both questions - see
 * `referral-invite-expiry.spec.ts`, which is where the TTL itself is pinned.
 * NINE days rather than thirty, because thirty was the window the service used
 * to hardcode: a 30-day fixture would make "the operator's setting reached the
 * row" and "the old hardcoded default reached the row" indistinguishable.
 */
const OPERATOR_EXPIRY = new Date(NOW + 9 * DAY_MS);

interface Harness {
  readonly service: ReferralsService;
  /** One entry per `referralInvite.create`, exactly as Prisma received it. */
  readonly writes: readonly { readonly data: Record<string, unknown> }[];
  /** One entry per `getCapacity`, carrying the user id it was asked about. */
  readonly capacityAsked: readonly string[];
  /** One entry per `resolveInviteExpiry`, carrying the user id it was asked about. */
  readonly expiryAsked: readonly string[];
  /** One entry per `user.findUnique`, exactly as Prisma received it. */
  readonly inviterLookups: readonly Record<string, unknown>[];
}

function harness(
  capacity: CapacityAnswer,
  options: { readonly inviterExists?: boolean } = {},
): Harness {
  const writes: { data: Record<string, unknown> }[] = [];
  const capacityAsked: string[] = [];
  const expiryAsked: string[] = [];
  const inviterLookups: Record<string, unknown>[] = [];
  let minted = 0;

  const service = new ReferralsService(
    {
      user: {
        findUnique: async (args: Record<string, unknown>): Promise<unknown> => {
          inviterLookups.push(args);
          if (options.inviterExists === false) return null;
          const where = args.where as { id: string };
          return { id: where.id };
        },
      },
      referralInvite: {
        create: async (args: { data: Record<string, unknown> }): Promise<unknown> => {
          writes.push(args);
          minted += 1;
          return {
            id: `invite-${minted}`,
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
    } as never,
    {
      getCapacity: async (userId: string): Promise<CapacityAnswer> => {
        capacityAsked.push(userId);
        return capacity;
      },
      resolveInviteExpiry: async (userId: string): Promise<Date | null> => {
        expiryAsked.push(userId);
        return OPERATOR_EXPIRY;
      },
    } as never,
  );

  return { service, writes, capacityAsked, expiryAsked, inviterLookups };
}

/** The `{ code, message }` body off a thrown `BadRequestException`. */
function refusalBody(error: unknown): { code?: unknown; message?: unknown } {
  assert.ok(
    error instanceof BadRequestException,
    `expected a BadRequestException, got ${String(error)}`,
  );
  return error.getResponse() as { code?: unknown; message?: unknown };
}

describe('ReferralsService.createInvite honours the per-user invite quota', () => {
  it('refuses an over-quota creation and names it with the invite-quota code', async () => {
    const { service } = harness(SPENT);

    await assert.rejects(
      () => service.createInvite({ inviterId: 'inviter-1' }),
      (error: unknown) => {
        const payload = refusalBody(error);
        assert.equal(payload.code, INVITE_SLOT_LIMIT_REACHED_CODE);
        assert.equal(payload.message, INVITE_SLOT_LIMIT_REACHED_MESSAGE);
        return true;
      },
    );
  });

  it('writes no ReferralInvite row when the quota is spent', async () => {
    const { service, writes } = harness(SPENT);

    await assert.rejects(
      () => service.createInvite({ inviterId: 'inviter-1' }),
      BadRequestException,
    );

    // The refusal is worth nothing if the row was written first. This is the
    // assertion that pins the ORDER, not merely the throw.
    assert.deepStrictEqual(
      writes.map((call) => call.data),
      [],
      'an over-quota creation must leave the ReferralInvite table untouched',
    );
  });

  it('still mints an invite when the quota has room, and still returns { invite }', async () => {
    const { service, writes } = harness(HAS_ROOM);

    const result = await service.createInvite({ inviterId: 'inviter-1', note: 'campaign' });

    // The envelope the admin route returns is unchanged: `{ invite }`.
    assert.deepStrictEqual(Object.keys(result), ['invite']);
    assert.equal(result.invite.inviter.id, 'inviter-1');
    assert.equal(result.invite.note, 'campaign');

    // ...and the row Prisma was actually handed, not the fact that it was called.
    assert.equal(writes.length, 1);
    const written = writes[0].data;
    assert.equal(written.inviterId, 'inviter-1');
    assert.equal(written.note, 'campaign');
    assert.ok(typeof written.token === 'string' && written.token.length > 0);
    // The expiry is the OPERATOR'S, taken from the limits service - not a
    // window this service invents. Compared by identity, because "some date in
    // the future" is equally true of the hardcoded 30 days that used to stand
    // here regardless of what the operator had configured.
    assert.deepStrictEqual(written.expiresAt, OPERATOR_EXPIRY);
  });

  it('never refuses a user whose quota is unlimited (null slots)', async () => {
    // THE REGRESSION THAT MUST NOT COME BACK. `null` is the VIP-bypass answer,
    // and it arrives with `canCreateInvite: true`. A gate that reads
    // `remainingSlots ?? 0` refuses here while leaving every other case green.
    assert.equal(UNLIMITED.totalSlots, null, 'fixture guard: this case is about null slots');
    assert.equal(UNLIMITED.remainingSlots, null, 'fixture guard: this case is about null slots');

    const { service, writes } = harness(UNLIMITED);

    const result = await service.createInvite({ inviterId: 'vip-1' });

    assert.equal(result.invite.inviter.id, 'vip-1');
    assert.equal(writes.length, 1, 'an unlimited quota must mint the invite, not refuse it');
    assert.equal(writes[0].data.inviterId, 'vip-1');
  });

  it('asks the limits service about the inviter named in the request', async () => {
    const { service, capacityAsked } = harness(HAS_ROOM);

    await service.createInvite({ inviterId: 'inviter-7' });

    // The ARGUMENT, not the count: a gate that asks about the wrong user is a
    // gate that reports someone else's quota.
    assert.deepStrictEqual(capacityAsked, ['inviter-7']);
  });

  it('answers 404 for a missing inviter without consulting the quota', async () => {
    const { service, capacityAsked, expiryAsked, writes, inviterLookups } = harness(SPENT, {
      inviterExists: false,
    });

    await assert.rejects(
      () => service.createInvite({ inviterId: 'ghost-1' }),
      NotFoundException,
      'a bad id must stay a 404, not become a quota refusal',
    );

    assert.deepStrictEqual(inviterLookups, [{ where: { id: 'ghost-1' }, select: { id: true } }]);
    assert.deepStrictEqual(capacityAsked, []);
    // And neither is the TTL: both now hang off this write site, so both must
    // stay behind the existence check.
    assert.deepStrictEqual(expiryAsked, []);
    assert.deepStrictEqual(
      writes.map((call) => call.data),
      [],
    );
  });

  it('refuses on the quota before it resolves an expiry, let alone writes one', async () => {
    // ORDER, not merely outcome. Resolving the TTL first would be a wasted
    // query on every refusal - and on the real service that query reads the
    // settings row and the user's override.
    const { service, capacityAsked, expiryAsked, writes } = harness(SPENT);

    await assert.rejects(
      () => service.createInvite({ inviterId: 'inviter-1' }),
      BadRequestException,
    );

    assert.deepStrictEqual(capacityAsked, ['inviter-1']);
    assert.deepStrictEqual(expiryAsked, []);
    assert.deepStrictEqual(
      writes.map((call) => call.data),
      [],
    );
  });

  it('control: the fake records a row for every create, so an empty log is a real zero', async () => {
    // Without this, every "no row was written" assertion above would also pass
    // against a stub that silently records nothing - the inert-observer failure
    // this repository has already paid for.
    const { service, writes, expiryAsked } = harness(HAS_ROOM);

    await service.createInvite({ inviterId: 'inviter-1' });
    await service.createInvite({ inviterId: 'inviter-2' });

    assert.deepStrictEqual(
      writes.map((call) => call.data.inviterId),
      ['inviter-1', 'inviter-2'],
    );
    // Same control for the expiry log, which the two cases above assert is
    // EMPTY: it records every call it does receive, and about whom.
    assert.deepStrictEqual(expiryAsked, ['inviter-1', 'inviter-2']);
  });
});

describe('the invite-quota refusal survives onto the wire', () => {
  it('lists INVITE_SLOT_LIMIT_REACHED in SAFE_PRODUCT_CODES', () => {
    // `findSafeProductPayload` gates on this set and returns `undefined` on a
    // miss, which strips the code entirely. Checked by NAME here so a rename on
    // either side fails a test instead of shipping an untyped 400.
    assert.ok(
      SAFE_PRODUCT_CODES.has(INVITE_SLOT_LIMIT_REACHED_CODE),
      `${INVITE_SLOT_LIMIT_REACHED_CODE} is not allowlisted in SAFE_PRODUCT_CODES: ` +
        'the panel receives an untyped 400 and can only print English',
    );
  });

  it('carries the code, the errorCode and the sentence through AdminSafeExceptionFilter', async () => {
    const { service } = harness(SPENT);

    const thrown = await service
      .createInvite({ inviterId: 'inviter-1' })
      .then(() => null)
      .catch((error: unknown) => error);
    assert.ok(thrown !== null, 'expected the quota refusal to throw');

    const captured = runFilter(thrown, {
      originalUrl: '/api/admin/referrals/invites',
      headers: { 'x-request-id': 'request.invite-quota' },
    });
    const body = captured.body as Record<string, unknown>;

    assert.equal(captured.statusCode, 400);
    assert.equal(body.code, INVITE_SLOT_LIMIT_REACHED_CODE);
    // The filter writes the product code into `errorCode` too; the SPA reads
    // `code` first and falls back to `errorCode`.
    assert.equal(body.errorCode, INVITE_SLOT_LIMIT_REACHED_CODE);
    // And the sentence is not scrubbed: it trips none of the sensitive-text
    // patterns, which is only true because it interpolates nothing.
    assert.equal(body.message, INVITE_SLOT_LIMIT_REACHED_MESSAGE);
  });
});

interface CapturedResponse {
  statusCode?: number;
  body?: unknown;
}

/** Same harness as `admin-safe-exception.filter.spec.ts`, kept local to this file. */
function runFilter(
  exception: unknown,
  request: { originalUrl: string; headers: Record<string, string> },
): CapturedResponse {
  const captured: CapturedResponse = {};
  const response = {
    status(statusCode: number) {
      captured.statusCode = statusCode;
      return response;
    },
    json(payload: unknown) {
      captured.body = payload;
      return response;
    },
  };
  const host = {
    switchToHttp() {
      return {
        getRequest: () => request,
        getResponse: () => response,
      };
    },
  } as unknown as ArgumentsHost;

  new AdminSafeExceptionFilter().catch(exception, host);
  return captured;
}
