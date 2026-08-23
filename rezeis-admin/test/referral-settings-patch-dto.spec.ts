import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import {
  MIN_INVITE_COUNT_SETTING,
  MIN_LINK_TTL_SECONDS,
} from '../src/modules/referrals/services/referral-invite-limits.service';
import { SettingsController } from '../src/modules/settings/controllers/settings.controller';
import { UpdateReferralSettingsDto } from '../src/modules/settings/dto/update-referral-settings.dto';
import { SettingsService } from '../src/modules/settings/services/settings.service';

/**
 * `PATCH /admin/settings/referral` AND THE VALIDATION THAT NEVER RAN.
 *
 * The handler's `@Body()` was `Record<string, unknown>`. Its metatype is
 * `Object`, and the global `ValidationPipe` in `main.ts` skips a handler whose
 * body metatype is `Object` — so not one decorator ran on this route, and
 * `forbidNonWhitelisted` never saw the body either. Everything posted was
 * written verbatim into `Settings.referralSettings`.
 *
 * The clamp people point at is in the PANEL (`parseBoundedInt` in
 * `referral-settings-page.tsx`). It is a UI clamp: `curl`, a script, or an
 * older SPA build writes a negative straight past it.
 * `ReferralInviteLimitsService.normalizeLimits` catches part of it on READ, but
 * only for values behind an ENABLED toggle — values behind a disabled one are
 * deliberately unclamped and unread, so a bad number sits in the column until
 * somebody flips the switch that starts reading it.
 *
 * ── WHAT THIS FILE ASSERTS, AND HOW ──────────────────────────────────────────
 *
 * Nothing here calls `validate()` on the DTO class directly. A DTO can be
 * perfect and still never run, which is the entire defect, so every body below
 * goes through a `ValidationPipe` CONSTRUCTED EXACTLY LIKE `main.ts` and the
 * route's own metatype is asserted separately. Route-level cases then run
 * pipe → controller → the real `SettingsService` → a fake Prisma, and assert
 * the JSON handed to `settings.update` rather than a spy's call count.
 *
 * Fixture timestamps are relative — an absolute date in this repo was live when
 * written and silently became something else months later.
 */

/** The production pipe, byte for byte — see `src/main.ts`. */
const PRODUCTION_PIPE = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

async function throughPipe(body: unknown): Promise<UpdateReferralSettingsDto> {
  return (await PRODUCTION_PIPE.transform(body, {
    type: 'body',
    metatype: UpdateReferralSettingsDto,
  })) as UpdateReferralSettingsDto;
}

/** Asserts a 400 whose message names the field that was refused. */
async function rejectsNaming(body: unknown, field: string): Promise<void> {
  await assert.rejects(
    () => throughPipe(body),
    (error: unknown) => {
      const response = (error as { getResponse?: () => unknown }).getResponse?.() as
        | { message?: string[] }
        | undefined;
      const messages = response?.message ?? [];
      assert.equal(
        messages.some((message) => message.includes(field)),
        true,
        `the validation error must name ${field}; got ${JSON.stringify(messages)}`,
      );
      return true;
    },
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

const ADMIN: CurrentAdminInterface = {
  id: 'admin-1',
  login: 'admin',
  email: 'admin@example.test',
  name: 'Admin',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date(Date.now() - 30 * DAY_MS),
  lastLoginAt: new Date(Date.now() - DAY_MS),
  lastLoginIp: '203.0.113.9',
  rbacRoleId: null,
  mustChangePassword: false,
};

const REQ = {
  headers: { 'x-request-id': 'request-referral-1' },
  ip: '203.0.113.10',
  socket: { remoteAddress: '203.0.113.10' },
} as never;

/**
 * EXACTLY the body `referral-settings-page.tsx` submits, with the shapes its
 * own code produces: `undefined` for an empty reward box (dropped by
 * `JSON.stringify` before it leaves the browser, so it is simply absent here),
 * `null` for an empty TTL box, `0` for a deliberate slot lockout.
 */
const PANEL_BODY = {
  enabled: true,
  invitedOnly: false,
  accrualStrategy: 'ON_FIRST_PAYMENT',
  rewardType: 'EXTRA_DAYS',
  level1Reward: 5,
  level2Reward: 2,
  pointsPerReferral: 10,
  eligiblePlanIds: ['plan-monthly', 'plan-yearly'],
  inviteLimits: {
    linkTtlEnabled: true,
    linkTtlSeconds: 7 * 86400,
    slotsEnabled: true,
    initialSlots: 0,
  },
  pointsExchange: {
    exchangeEnabled: true,
    subscriptionDays: { enabled: true, pointsCost: 1 },
    giftSubscription: {
      enabled: false,
      pointsCost: 30,
      giftDurationDays: 30,
      giftPlanId: null,
    },
    discount: { enabled: false, pointsCost: 10, maxDiscountPercent: 50 },
    traffic: { enabled: false, pointsCost: 5, maxTrafficGb: 100 },
  },
} as const;

interface SettingsRow {
  id: string;
  referralSettings: Record<string, unknown>;
  updatedAt: Date;
}

/**
 * Fake Prisma that HOLDS the settings row and records the `data` object handed
 * to `settings.update`. Recording the data is the point: a double that only
 * counts calls cannot tell "the field was written" from "the endpoint ran and
 * dropped it".
 */
function makeSettingsDb(referralSettings: Record<string, unknown>) {
  const row: SettingsRow = {
    id: 'settings-1',
    referralSettings,
    updatedAt: new Date(Date.now() - DAY_MS),
  };
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const auditLogs: Array<Record<string, unknown>> = [];

  const transactionClient = {
    settings: {
      findFirst: async () => row,
      create: async () => row,
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        row.referralSettings = args.data.referralSettings as Record<string, unknown>;
        row.updatedAt = new Date();
        return row;
      },
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditLogs.push(args.data);
        return args.data;
      },
    },
  };

  const prismaService = {
    settings: { findFirst: async () => row, create: async () => row },
    $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
  };

  const service = new SettingsService(prismaService as never, {} as never, {
    cryptKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  } as never);
  const controller = new SettingsController(service, {} as never, {} as never);

  return { controller, updates, auditLogs, row };
}

/** The `referralSettings` JSON the endpoint asked the database to store. */
function storedReferralSettings(
  db: ReturnType<typeof makeSettingsDb>,
): Record<string, unknown> {
  assert.equal(db.updates.length, 1, 'exactly one settings.update was expected');
  return db.updates[0]?.data.referralSettings as Record<string, unknown>;
}

// ── 1. The route has a metatype the pipe will not skip ───────────────────────
//
// This is the defect itself, and it is invisible to every test that validates
// the DTO class by hand: the DTO can be perfect and the route can still take a
// bare object, in which case NOTHING below it runs.

describe('PATCH /admin/settings/referral — the pipe actually runs on this route', () => {
  it('declares the DTO as its body metatype, not Object', () => {
    const paramTypes = Reflect.getMetadata(
      'design:paramtypes',
      SettingsController.prototype,
      'updateReferralSettings',
    ) as unknown[];

    assert.notEqual(
      paramTypes[0],
      Object,
      'a body metatype of Object makes the global ValidationPipe skip the whole route',
    );
    assert.equal(paramTypes[0], UpdateReferralSettingsDto);
  });
});

// ── 2. Negatives are refused ─────────────────────────────────────────────────

describe('referral settings patch — the numbers that broke things', () => {
  it('refuses a negative initialSlots', async () => {
    await rejectsNaming({ inviteLimits: { initialSlots: -1 } }, 'initialSlots');
  });

  it('refuses a negative refillAmount and a negative refill threshold', async () => {
    await rejectsNaming({ inviteLimits: { refillAmount: -5 } }, 'refillAmount');
    await rejectsNaming(
      { inviteLimits: { refillThresholdQualified: -1 } },
      'refillThresholdQualified',
    );
  });

  it('refuses a link TTL below the service\'s own floor, zero included', async () => {
    await rejectsNaming({ inviteLimits: { linkTtlSeconds: -1 } }, 'linkTtlSeconds');
    // Zero is the value that mints an invite already expired at the instant it
    // is written — the reason `MIN_LINK_TTL_SECONDS` is 60 and not 0.
    await rejectsNaming({ inviteLimits: { linkTtlSeconds: 0 } }, 'linkTtlSeconds');
    await rejectsNaming(
      { inviteLimits: { linkTtlSeconds: MIN_LINK_TTL_SECONDS - 1 } },
      'linkTtlSeconds',
    );
  });

  it('refuses a negative reward at either level', async () => {
    await rejectsNaming({ level1Reward: -1 }, 'level1Reward');
    await rejectsNaming({ level2Reward: -1 }, 'level2Reward');
    await rejectsNaming({ pointsPerReferral: -1 }, 'pointsPerReferral');
  });

  it('refuses a zero or negative pointsCost, which the exchange divides by', async () => {
    await rejectsNaming(
      { pointsExchange: { subscriptionDays: { pointsCost: 0 } } },
      'pointsCost',
    );
    await rejectsNaming({ pointsExchange: { traffic: { pointsCost: -5 } } }, 'pointsCost');
  });

  it('refuses a discount ceiling above 100 percent', async () => {
    await rejectsNaming({ pointsExchange: { discount: { maxDiscountPercent: 101 } } }, 'maxDiscountPercent');
  });

  it('refuses a key nobody sends, because forbidNonWhitelisted now reaches this body', async () => {
    await rejectsNaming({ enabled: true, notAReferralSetting: 1 }, 'notAReferralSetting');
    // Nested too: the sections are validated objects, not opaque JSON.
    await rejectsNaming({ inviteLimits: { linkTtlDays: 7 } }, 'linkTtlDays');
  });

  it('refuses a value of the wrong TYPE rather than coercing it', async () => {
    // `transform: true` without `enableImplicitConversion` does not turn a
    // string into a number, and it must not: `Number('')` is 0, which is a real
    // and different setting from "the box was empty".
    await rejectsNaming({ inviteLimits: { initialSlots: '3' } }, 'initialSlots');
    await rejectsNaming({ enabled: 'yes' }, 'enabled');
    await rejectsNaming({ accrualStrategy: 'ON_EVERY_PAYMENT' }, 'accrualStrategy');
  });
});

// ── 3. Everything the panel legitimately sends still validates ───────────────

describe('referral settings patch — the panel\'s own body', () => {
  it('accepts the complete payload the settings form submits', async () => {
    const dto = await throughPipe(structuredClone(PANEL_BODY));

    assert.equal(dto.enabled, true);
    assert.equal(dto.invitedOnly, false);
    assert.equal(dto.accrualStrategy, 'ON_FIRST_PAYMENT');
    assert.equal(dto.rewardType, 'EXTRA_DAYS');
    assert.equal(dto.level1Reward, 5);
    assert.deepStrictEqual(dto.eligiblePlanIds, ['plan-monthly', 'plan-yearly']);
    assert.equal(dto.inviteLimits?.linkTtlSeconds, 7 * 86400);
    assert.equal(dto.inviteLimits?.initialSlots, 0);
    assert.equal(dto.pointsExchange?.giftSubscription?.giftPlanId, null);
    assert.equal(dto.pointsExchange?.discount?.maxDiscountPercent, 50);
  });

  it('accepts an EMPTY eligible-plan list, which means "every plan qualifies"', async () => {
    const dto = await throughPipe({ eligiblePlanIds: [] });
    assert.deepStrictEqual(dto.eligiblePlanIds, []);
  });

  it('accepts the two knobs the form does not render but the service reads', async () => {
    const dto = await throughPipe({
      inviteLimits: { refillThresholdQualified: 3, refillAmount: 2 },
    });
    assert.equal(dto.inviteLimits?.refillThresholdQualified, 3);
    assert.equal(dto.inviteLimits?.refillAmount, 2);
  });

  it('accepts the documented "no cap" sentinel on every ceiling', async () => {
    const dto = await throughPipe({
      pointsExchange: {
        maxExchangePoints: -1,
        subscriptionDays: { maxPoints: -1 },
      },
    });
    assert.equal(dto.pointsExchange?.maxExchangePoints, -1);
    assert.equal(dto.pointsExchange?.subscriptionDays?.maxPoints, -1);
  });
});

// ── 4. Omitted, null and zero survive as three different requests ────────────

describe('referral settings patch — omitted vs null vs zero, through the pipe', () => {
  it('an omitted field leaves the property ABSENT, not null and not zero', async () => {
    const dto = await throughPipe({ inviteLimits: { slotsEnabled: true } });

    assert.equal('initialSlots' in (dto.inviteLimits ?? {}), false);
    assert.equal(dto.inviteLimits?.initialSlots, undefined);
    assert.equal('level1Reward' in dto, false);
  });

  it('an explicit null SURVIVES the pipe as null', async () => {
    const dto = await throughPipe({
      level1Reward: null,
      inviteLimits: { linkTtlSeconds: null, initialSlots: null },
    });

    assert.equal('level1Reward' in dto, true);
    assert.equal(dto.level1Reward, null);
    assert.equal('linkTtlSeconds' in (dto.inviteLimits ?? {}), true);
    assert.equal(dto.inviteLimits?.linkTtlSeconds, null);
    assert.equal(dto.inviteLimits?.initialSlots, null);
  });

  it('a zero survives as zero, and is not confused with either', async () => {
    const dto = await throughPipe({
      level1Reward: 0,
      inviteLimits: {
        initialSlots: MIN_INVITE_COUNT_SETTING,
        refillThresholdQualified: 0,
        refillAmount: 0,
      },
    });

    assert.equal(dto.level1Reward, 0);
    assert.equal(dto.inviteLimits?.initialSlots, 0);
    assert.equal(dto.inviteLimits?.refillThresholdQualified, 0);
    assert.equal(dto.inviteLimits?.refillAmount, 0);
  });
});

// ── 5. Control ───────────────────────────────────────────────────────────────
//
// Every route-level assertion below reads `db.updates[0]`. This proves the fake
// records an update at all, so "the stored value survived" cannot pass for the
// wrong reason.

describe('referral settings patch — the fake records the write (control)', () => {
  it('a field that is plainly wired reaches settings.update.data', async () => {
    const db = makeSettingsDb({ enabled: false });

    await db.controller.updateReferralSettings(await throughPipe({ enabled: true }), ADMIN, REQ);

    assert.equal(db.updates.length, 1);
    assert.deepStrictEqual(storedReferralSettings(db), { enabled: true });
    assert.deepStrictEqual(db.row.referralSettings, { enabled: true });
    assert.equal(db.auditLogs.length, 1);
  });
});

// ── 6. The three states, all the way to the JSON column ──────────────────────

describe('referral settings patch — omitted vs null vs zero, all the way to storage', () => {
  const stored = () => ({
    enabled: true,
    inviteLimits: { slotsEnabled: true, initialSlots: 7, linkTtlSeconds: 86400 },
  });

  it('OMITTED leaves the stored value untouched', async () => {
    const db = makeSettingsDb(stored());

    await db.controller.updateReferralSettings(
      await throughPipe({ inviteLimits: { slotsEnabled: false } }),
      ADMIN,
      REQ,
    );

    assert.deepStrictEqual(storedReferralSettings(db), {
      enabled: true,
      inviteLimits: { slotsEnabled: false, initialSlots: 7, linkTtlSeconds: 86400 },
    });
  });

  it('NULL clears the value — "unlimited" / "no expiry", not "leave it"', async () => {
    const db = makeSettingsDb(stored());

    await db.controller.updateReferralSettings(
      await throughPipe({ inviteLimits: { initialSlots: null, linkTtlSeconds: null } }),
      ADMIN,
      REQ,
    );

    const next = storedReferralSettings(db);
    const limits = next.inviteLimits as Record<string, unknown>;
    assert.equal('initialSlots' in limits, true);
    assert.equal(limits.initialSlots, null);
    assert.equal(limits.linkTtlSeconds, null);
    // And the neighbour it must NOT have touched.
    assert.equal(limits.slotsEnabled, true);
  });

  it('ZERO is stored as zero — a deliberate lockout, not a cleared field', async () => {
    const db = makeSettingsDb(stored());

    await db.controller.updateReferralSettings(
      await throughPipe({ inviteLimits: { initialSlots: 0 } }),
      ADMIN,
      REQ,
    );

    const limits = storedReferralSettings(db).inviteLimits as Record<string, unknown>;
    assert.equal(limits.initialSlots, 0);
    assert.notEqual(limits.initialSlots, null);
    assert.equal(limits.linkTtlSeconds, 86400);
  });

  it('stores the panel\'s whole body as plain JSON, section by section', async () => {
    const db = makeSettingsDb({});

    await db.controller.updateReferralSettings(
      await throughPipe(structuredClone(PANEL_BODY)),
      ADMIN,
      REQ,
    );

    // `deepStrictEqual` compares prototypes, so this also pins that what lands
    // in the JSON column is plain data rather than DTO instances two levels
    // down — a shape no reader of this column ever produces.
    assert.deepStrictEqual(storedReferralSettings(db), structuredClone(PANEL_BODY));
  });
});

// ── 7. The negative the DTO now refuses used to reach the column ─────────────

describe('referral settings patch — a negative never reaches the column', () => {
  const seed = (): Record<string, unknown> => ({
    inviteLimits: { slotsEnabled: true, initialSlots: 7 },
  });

  it('is refused before the handler, so settings.update is never called', async () => {
    const db = makeSettingsDb(seed());

    await assert.rejects(async () => {
      const dto = await throughPipe({ inviteLimits: { initialSlots: -3 } });
      await db.controller.updateReferralSettings(dto, ADMIN, REQ);
    });

    // The control above proves this fake records an update when one happens,
    // so an empty list here means the write did not occur — not that the
    // double is inert.
    assert.deepStrictEqual(db.updates, []);
    assert.deepStrictEqual(db.row.referralSettings, seed());
  });
});
