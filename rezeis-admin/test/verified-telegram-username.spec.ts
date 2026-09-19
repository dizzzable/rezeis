import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BedolagaImporterService } from '../src/modules/imports/services/bedolaga-importer.service';
import type { BedolagaUser } from '../src/modules/imports/utils/bedolaga-backup-parser';
import { InternalUserEdgeService } from '../src/modules/internal-user/services/internal-user-edge.service';
import { PointsWalletService } from '../src/modules/points/services/points-wallet.service';
import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';
import { AdminUserWebController } from '../src/modules/users/controllers/admin-user-web.controller';
import { verifiedTelegramUsername } from '../src/modules/users/utils/verified-telegram-username.util';

/**
 * `users.telegram_username` + `users.telegram_username_tg_id`: the @username as
 * TELEGRAM reported it, and the Telegram account it belongs to.
 *
 * `users.username` could not answer "is this the linked account's nick": every
 * donor importer, the Remnawave importer and the admin «create user» form write
 * it too, and a Telegram rebind or an account merge leaves it naming the
 * previous account. The pair is written by the Telegram-verified bootstrap
 * alone — bot `/start` and the Mini App sign-in — and is valid only while its
 * id is the row's current `telegram_id`.
 */

const TG_ID = 555000111n;

// ═════════════════════════════════════════════════════════════════════════════
//  The one writer: the Telegram-verified bootstrap
// ═════════════════════════════════════════════════════════════════════════════

function bootstrapHarness(existing: { id: string; isBlocked: boolean } | null) {
  const upserts: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const prisma = {
    user: {
      findUnique: async () => existing,
      upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        upserts.push(args);
        return {
          id: existing?.id ?? 'cmnewuser000000000000000n1',
          telegramId: TG_ID,
          username: (args.update['username'] as string | null) ?? null,
          name: 'Bob',
          email: null,
          role: 'USER',
          language: 'EN',
          personalDiscount: 0,
          purchaseDiscount: 0,
          points: 0,
          maxSubscriptions: 1,
          isBlocked: false,
          isBotBlocked: false,
          isRulesAccepted: true,
          onboardingCompletedAt: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          lastSeenAt: null,
          webAccount: null,
        };
      },
    },
  };
  const service = new InternalUserEdgeService(
    prisma as never,
    { getInternalPlatformPolicy: async () => ({ accessMode: 'OPEN' }) } as never,
    { evaluate: () => null } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    {} as never,
  );
  return { service, upserts };
}

describe('the Telegram-verified bootstrap writes the pair, always both', () => {
  it('a first /start writes the nick Telegram sent and the id it belongs to', async () => {
    const { service, upserts } = bootstrapHarness(null);

    await service.bootstrapByTelegram({ telegramId: String(TG_ID), username: 'johnny_tg', name: 'Bob' });

    assert.equal(upserts.length, 1);
    for (const data of [upserts[0].create, upserts[0].update]) {
      assert.equal(data['telegramUsername'], 'johnny_tg');
      assert.equal(data['telegramUsernameTgId'], TG_ID);
    }
  });

  it('a later /start or Mini App sign-in rewrites the pair with the nick Telegram sends now', async () => {
    const { service, upserts } = bootstrapHarness({ id: 'cmbob00000000000000000b1', isBlocked: false });

    await service.bootstrapByTelegram({ telegramId: String(TG_ID), username: 'johnny_new', name: 'Bob' });

    assert.equal(upserts[0].update['telegramUsername'], 'johnny_new');
    assert.equal(upserts[0].update['telegramUsernameTgId'], TG_ID);
  });

  it('an account Telegram sends WITHOUT a nick is recorded as "verified: no nick" — null and the id', async () => {
    for (const username of [undefined, null, '']) {
      const { service, upserts } = bootstrapHarness({ id: 'cmbob00000000000000000b1', isBlocked: false });

      await service.bootstrapByTelegram({ telegramId: String(TG_ID), username, name: 'Bob' });

      for (const data of [upserts[0].create, upserts[0].update]) {
        assert.equal(data['telegramUsername'], null, JSON.stringify(username));
        assert.equal(data['telegramUsernameTgId'], TG_ID, JSON.stringify(username));
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Everything else that writes `users.username` leaves the pair alone
// ═════════════════════════════════════════════════════════════════════════════

const PAIR_KEYS = ['telegramUsername', 'telegramUsernameTgId'] as const;

function assertNoPair(data: Record<string, unknown>, context: string): void {
  for (const key of PAIR_KEYS) {
    assert.equal(key in data, false, `${context} must not write ${key}`);
  }
}

function bedolagaDonor(overrides: Partial<BedolagaUser> = {}): BedolagaUser {
  return {
    id: 7,
    telegram_id: Number(TG_ID),
    username: 'donor_nick',
    first_name: 'Bob',
    last_name: null,
    status: 'active',
    language: 'ru',
    balance_kopeks: 0,
    referred_by_id: null,
    referral_code: null,
    email: null,
    promo_group_id: null,
    promo_offer_discount_percent: 0,
    promo_offer_discount_expires_at: null,
    has_had_paid_subscription: false,
    remnawave_id: null,
    ...overrides,
  } as BedolagaUser;
}

describe('a donor import writes users.username but never the verified pair', () => {
  function bedolaga(existingId: string | null) {
    const writes: Array<{ op: string; data: Record<string, unknown> }> = [];
    const prisma = {
      user: {
        findUnique: async () => (existingId === null ? null : { id: existingId }),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          writes.push({ op: 'create', data });
          return { id: 'cmminted00000000000000000' };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          writes.push({ op: 'update', data });
          return { id: existingId };
        },
      },
    };
    const service = new BedolagaImporterService(prisma as never, {} as never, {} as never);
    const internals = service as unknown as {
      matchOrCreateUser(donor: BedolagaUser, mode: 'import' | 'sync'): Promise<string | null>;
    };
    return { internals, writes };
  }

  it('matching an existing account overwrites its username, not the pair', async () => {
    const { internals, writes } = bedolaga('cmbob00000000000000000b1');

    await internals.matchOrCreateUser(bedolagaDonor(), 'sync');

    const update = writes.find((write) => write.op === 'update');
    assert.ok(update !== undefined, 'the importer did write the account');
    assert.equal(update.data['username'], 'donor_nick');
    assertNoPair(update.data, 'the Bedolaga update');
  });

  it('minting a new account from the donor row writes no pair', async () => {
    const { internals, writes } = bedolaga(null);

    await internals.matchOrCreateUser(bedolagaDonor(), 'import');

    const create = writes.find((write) => write.op === 'create');
    assert.ok(create !== undefined, 'the importer did create the account');
    assert.equal(create.data['username'], 'donor_nick');
    assertNoPair(create.data, 'the Bedolaga create');
  });
});

describe('the admin «create user» form writes users.username but never the verified pair', () => {
  it('an operator-typed @username stays out of the pair', async () => {
    const creates: Array<Record<string, unknown>> = [];
    const controller = new AdminUserManagementController(
      {
        user: {
          findFirst: async () => null,
          create: async ({ data }: { data: Record<string, unknown> }) => {
            creates.push(data);
            return { id: 'cmtyped000000000000000t1', telegramId: data['telegramId'] ?? null, ...data };
          },
        },
        adminAuditLog: { create: async () => undefined },
      } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      {} as never,
      undefined as never,
      { listForUser: async () => [], clear: async () => undefined } as never,
      new PointsWalletService(),
      { listForUser: async () => ({ items: [], nextCursor: null }) } as never,
    );

    await controller.createUser(
      { telegramId: String(TG_ID), username: 'typed_nick', name: 'Bob' },
      { id: 'admin-1' } as never,
      { headers: {}, socket: {} } as never,
    );

    assert.equal(creates.length, 1);
    assert.equal(creates[0]['username'], 'typed_nick');
    assertNoPair(creates[0], 'the admin create');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  What the pair means: valid only for the Telegram account it names
// ═════════════════════════════════════════════════════════════════════════════

describe('the pair is valid only while it names the linked Telegram account', () => {
  it('reads the nick for the account it was written for', () => {
    assert.equal(
      verifiedTelegramUsername({ telegramId: TG_ID, telegramUsername: 'johnny_tg', telegramUsernameTgId: TG_ID }),
      'johnny_tg',
    );
  });

  it('reads nothing for "verified: no nick", for an account never bootstrapped, or with no Telegram at all', () => {
    assert.equal(verifiedTelegramUsername({ telegramId: TG_ID, telegramUsername: null, telegramUsernameTgId: TG_ID }), null);
    assert.equal(verifiedTelegramUsername({ telegramId: TG_ID, telegramUsername: null, telegramUsernameTgId: null }), null);
    assert.equal(verifiedTelegramUsername({ telegramId: null, telegramUsername: 'x_nick', telegramUsernameTgId: TG_ID }), null);
  });

  it('an admin rebind to another Telegram account invalidates the stored pair, with no clean-up write', async () => {
    const row: Record<string, unknown> = {
      id: 'cmbob00000000000000000b1',
      telegramId: TG_ID,
      username: 'johnny_tg',
      telegramUsername: 'johnny_tg',
      telegramUsernameTgId: TG_ID,
    };
    const updates: Array<Record<string, unknown>> = [];
    const controller = new AdminUserWebController(
      {
        user: {
          findFirst: async ({ where }: { where: { telegramId?: bigint } }) =>
            where.telegramId === row['telegramId'] ? { ...row } : null,
          findUnique: async () => null,
          update: async ({ data }: { data: Record<string, unknown> }) => {
            updates.push(data);
            Object.assign(row, data);
            return { id: row['id'] };
          },
        },
        adminAuditLog: { create: async () => undefined },
      } as never,
      undefined as never,
      undefined as never,
    );
    const before = verifiedTelegramUsername(row as never);

    await controller.bindTelegramId(String(TG_ID), { telegramId: '777000222' }, { id: 'admin-1' } as never, {
      headers: {},
      socket: {},
    } as never);

    assert.equal(before, 'johnny_tg');
    assert.deepEqual(updates, [{ telegramId: 777000222n }], 'the rebind writes the id and nothing else');
    assert.equal(
      verifiedTelegramUsername(row as never),
      null,
      'the pair still names the previous account, so it proves nothing about the new one',
    );
  });
});
