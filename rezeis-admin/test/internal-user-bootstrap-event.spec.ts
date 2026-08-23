import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ReferralInviteSource } from '@prisma/client';

import { InternalUserEdgeService } from '../src/modules/internal-user/services/internal-user-edge.service';
import {
  ReferralManualAttachService,
  type ReferralManualAttachOperatorInterface,
} from '../src/modules/referrals/services/referral-manual-attach.service';

/**
 * Regression: `USER_REGISTERED` was defined but never emitted, so a user
 * starting the bot (Telegram-first bootstrap) created a row silently — devs
 * got no "new user registered" notification. `bootstrapByTelegram` must emit
 * exactly once for a brand-new user and stay quiet for a returning one.
 */

const STUB_SETTINGS = {
  getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' as const }),
};
interface GuardCall {
  readonly gate: string;
  readonly mode: string;
  readonly hasInvite: boolean;
}

function fakeUser(): unknown {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'user-cuid-1',
    telegramId: BigInt(1036459677),
    username: 'Frodmaker',
    name: 'Maylo',
    email: null,
    role: 'USER',
    language: 'RU',
    personalDiscount: 0,
    purchaseDiscount: 0,
    points: 0,
    maxSubscriptions: 1,
    isBlocked: false,
    isBotBlocked: false,
    isRulesAccepted: false,
    onboardingCompletedAt: null,
    createdAt: now,
    updatedAt: now,
    webAccount: null,
  };
}

interface EmittedEvent {
  readonly type: string;
  readonly category: string;
  readonly metadata?: Record<string, unknown>;
}

interface AttachCall {
  readonly userId: string;
  readonly referrerId: string;
  /**
   * Where the edge came from. This field is the point: `Referral.inviteSource`
   * stayed `UNKNOWN` for every organically created edge because the service
   * took no source parameter — and this interface had no field for one, so no
   * assertion in this file could have noticed. A double is only ever as
   * truthful as its shape.
   */
  readonly inviteSource: ReferralInviteSource;
  /**
   * Who performed the attach, or `null` for the two paths nobody performed.
   * Recorded for the same reason `inviteSource` is: the field is required so
   * the compiler names every call site, and a double blind to it could not
   * notice a sign-up that started attributing itself to an operator — nor an
   * operator route that started passing `null` and recording nothing.
   */
  readonly operator: ReferralManualAttachOperatorInterface | null;
}

function buildService(
  existing: { id: string } | null,
  options: {
    readonly referrer?: { id: string } | null;
    readonly invite?: { id: string; inviterId: string } | null;
    readonly attach?: (input: AttachCall) => Promise<void>;
    /** Simulate losing the single-use invite claim race (another sign-up won). */
    readonly claimLost?: boolean;
    /** Platform access mode seen by the register gate. */
    readonly accessMode?: 'PUBLIC' | 'INVITED';
    /** A `Referral` edge already exists for the new user (partial attach). */
    readonly referralEdgeExists?: boolean;
    /** The invite's inviter is banned — must not attribute. */
    readonly inviterBlocked?: boolean;
    /**
     * Replaces the recording double with a real `ReferralManualAttachService`,
     * so a test can follow the call all the way to `referral.create`.
     */
    readonly attachService?: ReferralManualAttachService;
  } = {},
) {
  const guardCalls: GuardCall[] = [];
  const events: EmittedEvent[] = [];
  const attachCalls: AttachCall[] = [];
  const inviteFindWheres: Record<string, unknown>[] = [];
  const consumeCalls: { id: string; consumedAt: unknown; whereConsumedAt?: unknown }[] = [];
  const prisma = {
    user: {
      findUnique: async () => existing,
      upsert: async () => fakeUser(),
      findFirst: async (args: { where: Record<string, unknown> }) => {
        // Two distinct lookups share this method:
        //  - `{ id, isBlocked: false }` confirms a matched invite's inviter is
        //    still a live account (parity with the web path);
        //  - `{ isBlocked: false, OR: [...] }` resolves a plain referral code.
        if (typeof args.where.id === 'string' && args.where.OR === undefined) {
          return options.inviterBlocked === true ? null : { id: args.where.id };
        }
        return options.referrer ?? null;
      },
    },
    referral: {
      // Consulted when releasing a claim after a failed attach: if the edge
      // already exists the invite really was spent and must stay consumed.
      findUnique: async () => (options.referralEdgeExists === true ? { id: 'referral-1' } : null),
    },
    referralInvite: {
      // Invite-token lookup in resolveReferrer. Capture the where-clause so a
      // test can assert the single-use guards (revoked/consumed/expired).
      findFirst: async (args: { where: Record<string, unknown> }) => {
        inviteFindWheres.push(args.where);
        return options.invite ?? null;
      },
      // Conditional claim / release. `claimLost: true` simulates a concurrent
      // sign-up having already consumed the invite (count === 0).
      updateMany: async (args: {
        where: { id: string; consumedAt?: unknown };
        data: { consumedAt: unknown };
      }) => {
        // Capture the WHERE guard, not just the payload: the single-use
        // protection lives entirely in `where.consumedAt`, so a test that
        // ignores it would stay green after the guard was deleted.
        consumeCalls.push({
          id: args.where.id,
          consumedAt: args.data.consumedAt,
          whereConsumedAt: 'consumedAt' in args.where ? args.where.consumedAt : 'ABSENT',
        });
        const isClaim = args.data.consumedAt !== null;
        // Losing the race is modelled the way the database does it: the
        // conditional update matches nothing because someone already claimed.
        if (isClaim && options.claimLost === true) return { count: 0 };
        return { count: 1 };
      },
    },
  };
  const systemEvents = {
    info: (type: string, category: string, _message: string, metadata?: Record<string, unknown>) => {
      events.push({ type, category, metadata });
    },
  };
  const referralManualAttach = {
    attachReferrerManually: async (input: AttachCall) => {
      attachCalls.push(input);
      if (options.attach) await options.attach(input);
    },
  };
  const accessMode = options.accessMode ?? 'PUBLIC';
  const settings =
    options.accessMode === undefined
      ? STUB_SETTINGS
      : { getInternalPlatformPolicy: async () => ({ accessMode }) };
  // Mirrors the real AccessModeGuard: INVITED admits a sign-up only when it
  // carries an invite. Capturing the calls is the point — the regression was
  // bootstrap passing a hardcoded `hasInvite: false`.
  const guard =
    options.accessMode === undefined
      ? { evaluate: () => null }
      : {
          evaluate: (call: GuardCall) => {
            guardCalls.push(call);
            return call.mode === 'INVITED' && !call.hasInvite
              ? { status: 403, code: 'INVITE_REQUIRED', message: 'invite required' }
              : null;
          },
        };
  const service = new InternalUserEdgeService(
    prisma as never,
    settings as never,
    guard as never,
    systemEvents as never,
    (options.attachService ?? referralManualAttach) as never,
  );
  return { service, events, attachCalls, inviteFindWheres, consumeCalls, guardCalls };
}

/**
 * Builds the REAL `ReferralManualAttachService` over a recording Prisma and
 * hands back the rows it writes.
 *
 * The double above can only ever prove what the CALLER passes. It cannot prove
 * the service does anything with it, and for the whole life of the column it
 * did not: `inviteSource` was hardcoded to `'UNKNOWN'` at the `referral.create`
 * and no spec in the repository reached that line. A test that stops at the
 * double re-tests the double.
 */
function buildRealAttachService(): {
  readonly attachService: ReferralManualAttachService;
  readonly created: Record<string, unknown>[];
} {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    // Both the user and the referrer must resolve, or the service throws
    // NotFound before it ever reaches the create.
    user: { findUnique: async (args: { where: { id: string } }) => ({ id: args.where.id }) },
    referral: {
      findUnique: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'referral-created-1' };
      },
    },
    partnerReferral: { findFirst: async () => null },
    transaction: { findMany: async () => [] },
  };
  const attachService = new ReferralManualAttachService(
    prisma as never,
    { qualifyReferralAfterPurchase: async () => undefined } as never,
    {
      attachPartnerReferralChain: async () => false,
      processPartnerEarning: async () => undefined,
    } as never,
    { info: () => undefined } as never,
  );
  return { attachService, created };
}

describe('InternalUserEdgeService.bootstrapByTelegram registration event', () => {
  it('emits USER_REGISTERED once for a brand-new Telegram user', async () => {
    const { service, events } = buildService(null);
    await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      language: 'RU',
    });
    const reg = events.filter((e) => e.type === 'user.registered');
    assert.equal(reg.length, 1);
    assert.equal(reg[0].category, 'USER');
    assert.equal(reg[0].metadata?.source, 'telegram_bot');
    assert.equal(reg[0].metadata?.telegramId, '1036459677');
    assert.equal(reg[0].metadata?.reiwaId, 'user-cuid-1');
  });

  it('does not emit when the user already exists (returning user)', async () => {
    const { service, events } = buildService({ id: 'user-cuid-1' });
    await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      language: 'RU',
    });
    assert.equal(events.filter((e) => e.type === 'user.registered').length, 0);
  });
});

describe('InternalUserEdgeService.bootstrapByTelegram referral binding', () => {
  it('binds the referrer from a ref_ deep-link token on a brand-new user', async () => {
    const { service, attachCalls } = buildService(null, { referrer: { id: 'referrer-1' } });
    await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      language: 'RU',
      referralCode: 'referrer-1',
    });
    assert.deepEqual(attachCalls, [
      {
        userId: 'user-cuid-1',
        referrerId: 'referrer-1',
        inviteSource: ReferralInviteSource.BOT,
        operator: null,
      },
    ]);
  });

  it('records BOT on the row the real attach service writes (ref_ deep-link)', async () => {
    // End-to-end past the double: the caller passing BOT proves nothing if the
    // service drops it, which is exactly what it used to do.
    const { attachService, created } = buildRealAttachService();
    const { service } = buildService(null, { referrer: { id: 'referrer-1' }, attachService });
    await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      language: 'RU',
      referralCode: 'referrer-1',
    });
    // The bot path swallows attach failures by design, so "wrote nothing" and
    // "wrote the right thing" are indistinguishable without this length check.
    assert.equal(created.length, 1);
    assert.equal(created[0].inviteSource, ReferralInviteSource.BOT);
    assert.equal(created[0].referrerId, 'referrer-1');
    assert.equal(created[0].referredId, 'user-cuid-1');
  });

  it('does NOT bind a referrer for a returning user even with a referralCode', async () => {
    const { service, attachCalls } = buildService(
      { id: 'user-cuid-1' },
      { referrer: { id: 'referrer-1' } },
    );
    await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      referralCode: 'referrer-1',
    });
    assert.equal(attachCalls.length, 0);
  });

  it('ignores an unknown referral code without failing bootstrap', async () => {
    const { service, attachCalls } = buildService(null, { referrer: null });
    const session = await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      referralCode: 'does-not-exist',
    });
    assert.equal(attachCalls.length, 0);
    assert.equal(session.id, 'user-cuid-1');
  });

  it('never lets an attach failure break bootstrap (best-effort)', async () => {
    const { service } = buildService(null, {
      referrer: { id: 'referrer-1' },
      attach: async () => {
        throw new Error('User already has a referral attribution');
      },
    });
    // Must resolve, not throw.
    const session = await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      referralCode: 'referrer-1',
    });
    assert.equal(session.id, 'user-cuid-1');
  });

  it('does not attempt binding when no referralCode is supplied', async () => {
    const { service, attachCalls } = buildService(null, { referrer: { id: 'referrer-1' } });
    await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
    });
    assert.equal(attachCalls.length, 0);
  });
});

describe('InternalUserEdgeService.bootstrapByTelegram invite-token binding', () => {
  it('binds the inviter from a bot ReferralInvite token and stamps consumedAt', async () => {
    // No matching user (so resolveReferrer falls through to the invite table).
    const { service, attachCalls, inviteFindWheres, consumeCalls } = buildService(null, {
      referrer: null,
      invite: { id: 'invite-1', inviterId: 'inviter-9' },
    });
    await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      referralCode: 'sometoken_base64url',
    });
    // Attributed to the invite's inviter, not the raw token.
    assert.deepEqual(attachCalls, [
      {
        userId: 'user-cuid-1',
        referrerId: 'inviter-9',
        inviteSource: ReferralInviteSource.BOT,
        operator: null,
      },
    ]);
    // Invite consumed exactly once, after the attach.
    assert.equal(consumeCalls.length, 1);
    assert.equal(consumeCalls[0].id, 'invite-1');
    // The claim is conditional — this guard is what makes the invite single-use.
    assert.equal(consumeCalls[0].whereConsumedAt, null);
    assert.ok(consumeCalls[0].consumedAt instanceof Date);
    // The lookup enforces single-use: not revoked, not consumed, not expired.
    const where = inviteFindWheres[0];
    assert.equal(where.token, 'sometoken_base64url');
    assert.equal(where.revokedAt, null);
    assert.equal(where.consumedAt, null);
    assert.ok(Array.isArray(where.OR));
  });

  it('releases the invite claim when the attach fails (invite not burned)', async () => {
    const { service, consumeCalls } = buildService(null, {
      referrer: null,
      invite: { id: 'invite-2', inviterId: 'inviter-9' },
      attach: async () => {
        throw new Error('User already has a referral attribution');
      },
    });
    const session = await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      referralCode: 'sometoken_base64url',
    });
    assert.equal(session.id, 'user-cuid-1');
    // Claimed, then released back to unconsumed — a failed sign-up must not
    // spend a genuine invite.
    assert.equal(consumeCalls.length, 2);
    assert.ok(consumeCalls[0].consumedAt instanceof Date);
    assert.equal(consumeCalls[1].consumedAt, null);
    // The release is fenced on OUR claim timestamp, so it can never reopen an
    // invite that a concurrent sign-up has since claimed.
    assert.equal(consumeCalls[1].whereConsumedAt, consumeCalls[0].consumedAt);
  });

  it('keeps the invite spent when the attach failed AFTER creating the referral edge', async () => {
    // `attachReferrerManually` is not atomic: it writes the Referral edge, then
    // replays partner/referral side-effects, any of which can throw. Releasing
    // the claim then would let a second user redeem the same single-use invite
    // and pay the inviter twice.
    const { service, consumeCalls } = buildService(null, {
      referrer: null,
      invite: { id: 'invite-6', inviterId: 'inviter-9' },
      referralEdgeExists: true,
      attach: async () => {
        throw new Error('partner chain failed after the referral edge was created');
      },
    });
    await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      referralCode: 'sometoken_base64url',
    });
    // Only the claim — no release.
    assert.equal(consumeCalls.length, 1);
    assert.ok(consumeCalls[0].consumedAt instanceof Date);
  });

  it('does not attribute to a banned inviter, and leaves the invite unspent', async () => {
    const { service, attachCalls, consumeCalls } = buildService(null, {
      referrer: null,
      invite: { id: 'invite-7', inviterId: 'banned-inviter' },
      inviterBlocked: true,
    });
    await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      referralCode: 'sometoken_base64url',
    });
    assert.equal(attachCalls.length, 0);
    assert.equal(consumeCalls.length, 0);
  });

  it('does not attribute when a concurrent sign-up already claimed the invite', async () => {
    // Both sign-ups read the invite as unconsumed; the conditional claim makes
    // exactly one of them the winner. The loser must not attach (otherwise a
    // single-use invite yields two referrals and two inviter rewards).
    const { service, attachCalls } = buildService(null, {
      referrer: null,
      invite: { id: 'invite-3', inviterId: 'inviter-9' },
      claimLost: true,
    });
    await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      referralCode: 'sometoken_base64url',
    });
    assert.equal(attachCalls.length, 0);
  });

  it('admits an INVITED-mode bot sign-up that carries a valid ref_ code', async () => {
    // Regression: bootstrap passed a hardcoded `hasInvite: false`, so under
    // INVITED an invited user was rejected before the row was even created —
    // and the bot swallows bootstrap errors, so it failed silently.
    const { service, guardCalls, attachCalls } = buildService(null, {
      accessMode: 'INVITED',
      referrer: null,
      invite: { id: 'invite-5', inviterId: 'inviter-9' },
    });
    const session = await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      referralCode: 'sometoken_base64url',
    });
    assert.equal(session.id, 'user-cuid-1');
    assert.equal(guardCalls[0].hasInvite, true);
    assert.deepEqual(attachCalls, [
      {
        userId: 'user-cuid-1',
        referrerId: 'inviter-9',
        inviteSource: ReferralInviteSource.BOT,
        operator: null,
      },
    ]);
  });

  it('still rejects an INVITED-mode sign-up with no code at all', async () => {
    const { service } = buildService(null, { accessMode: 'INVITED', referrer: null, invite: null });
    await assert.rejects(
      () =>
        service.bootstrapByTelegram({
          telegramId: '1036459677',
          username: 'Frodmaker',
          name: 'Maylo',
        }),
      /invite/i,
    );
  });

  it('rejects a PERMANENT sharing code under INVITED (admission needs a real invite)', async () => {
    // A reiwa_id / username / telegramId resolves to a referrer for
    // attribution, but accepting it as admission would make INVITED decorative:
    // every existing user would hold an unlimited, never-expiring pass.
    const { service } = buildService(null, {
      accessMode: 'INVITED',
      referrer: { id: 'referrer-1' },
      invite: null,
    });
    await assert.rejects(
      () =>
        service.bootstrapByTelegram({
          telegramId: '1036459677',
          username: 'Frodmaker',
          name: 'Maylo',
          referralCode: 'referrer-1',
        }),
      /INVITE_REQUIRED|invalid or has expired/i,
    );
  });

  it('rejects an INVITED-mode sign-up whose ref_ code resolves to nothing', async () => {
    // A bogus `ref_` payload must not be a free pass through the gate.
    const { service } = buildService(null, {
      accessMode: 'INVITED',
      referrer: null,
      invite: null,
    });
    await assert.rejects(
      () =>
        service.bootstrapByTelegram({
          telegramId: '1036459677',
          username: 'Frodmaker',
          name: 'Maylo',
          referralCode: 'dead-token',
        }),
      /INVITE_REQUIRED|invalid or has expired/i,
    );
  });

  it('prefers a live invite token over a user squatting it as their @username', async () => {
    // `username` is user-controlled and re-synced on every /start, so matching
    // users first would let an attacker hijack a link by renaming themselves.
    const { service, attachCalls } = buildService(null, {
      referrer: { id: 'squatter-1' },
      invite: { id: 'invite-4', inviterId: 'real-inviter' },
    });
    await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      referralCode: 'sometoken_base64url',
    });
    assert.deepEqual(attachCalls, [
      {
        userId: 'user-cuid-1',
        referrerId: 'real-inviter',
        inviteSource: ReferralInviteSource.BOT,
        operator: null,
      },
    ]);
  });

  it('ignores an unknown/expired invite token without binding or consuming', async () => {
    // Neither a user nor a live invite matches (an expired/revoked/consumed
    // invite is filtered out by the query → null here).
    const { service, attachCalls, consumeCalls } = buildService(null, {
      referrer: null,
      invite: null,
    });
    await service.bootstrapByTelegram({
      telegramId: '1036459677',
      username: 'Frodmaker',
      name: 'Maylo',
      referralCode: 'dead-token',
    });
    assert.equal(attachCalls.length, 0);
    assert.equal(consumeCalls.length, 0);
  });
});
