import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ValidationPipe } from '@nestjs/common';
import { PartnerAccrualStrategy } from '@prisma/client';

import { AdminUserManagementController } from '../src/modules/users/controllers/admin-user-management.controller';
import { UpdatePartnerSettingsDto } from '../src/modules/users/dto/update-partner-settings.dto';

/**
 * `PATCH /admin/users/:telegramId/partner/settings` and the three per-level
 * accrual columns.
 *
 * WHY THIS FILE EXISTS. `updatePartnerSettings` builds its
 * `Prisma.PartnerUpdateInput` field by field. When
 * `level1AccrualStrategy`/`level2AccrualStrategy`/`level3AccrualStrategy` were
 * added to the DTO and to `partners`, no lines were added to that builder — so
 * a PATCH carrying them validated, returned 200 with a `Partner` body, and
 * wrote NOTHING. Every symptom an endpoint test normally looks at was green.
 *
 * So nothing here asserts a status code or a spy's call count. Every test
 * asserts the `data` object actually handed to `partner.update`, and the row
 * the fake Prisma holds afterwards.
 *
 * The three requests below are three DIFFERENT requests and must stay three
 * distinct assertions:
 *
 *   - field present with a value → the column is written
 *   - field ABSENT              → the column is not in `data` at all, and the
 *                                 stored value survives
 *   - field present as `null`   → the column is written as `null`, which is
 *                                 what "inherit the partner-wide toggle" is
 *
 * The last two are the pair that a `!== undefined` guard gets right and a
 * truthiness guard silently merges into one.
 *
 * Dates are relative — an absolute fixture date in this repo was live when
 * written and silently became an expired-subscription assertion months later.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const ADMIN = { id: 'admin-1' } as never;
const REQ = { headers: {}, ip: null, socket: { remoteAddress: null } } as never;

interface PartnerRow {
  id: string;
  userId: string;
  balance: number;
  totalEarned: number;
  totalWithdrawn: number;
  isActive: boolean;
  useGlobalSettings: boolean;
  accrualStrategy: PartnerAccrualStrategy;
  rewardType: string;
  level1Percent: number | null;
  level2Percent: number | null;
  level3Percent: number | null;
  level1FixedAmount: number | null;
  level2FixedAmount: number | null;
  level3FixedAmount: number | null;
  level1AccrualStrategy: PartnerAccrualStrategy | null;
  level2AccrualStrategy: PartnerAccrualStrategy | null;
  level3AccrualStrategy: PartnerAccrualStrategy | null;
  createdAt: Date;
  updatedAt: Date;
}

function makePartnerRow(overrides: Partial<PartnerRow> = {}): PartnerRow {
  const bornAt = new Date(Date.now() - 60 * DAY_MS);
  return {
    id: 'partner-1',
    userId: 'user-1',
    balance: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    isActive: true,
    useGlobalSettings: false,
    accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
    rewardType: 'PERCENT',
    level1Percent: null,
    level2Percent: null,
    level3Percent: null,
    level1FixedAmount: null,
    level2FixedAmount: null,
    level3FixedAmount: null,
    level1AccrualStrategy: null,
    level2AccrualStrategy: null,
    level3AccrualStrategy: null,
    createdAt: bornAt,
    updatedAt: bornAt,
    ...overrides,
  };
}

/**
 * Fake Prisma that HOLDS the partner row and applies each update to it, and
 * that records the raw `data` object it was handed. Recording the data is the
 * point: a double that only counts calls cannot tell "the field was written"
 * from "the endpoint ran and dropped it", which is exactly the defect that
 * shipped.
 */
function makeDb(row: PartnerRow) {
  const partners = [row];
  const updates: Array<Record<string, unknown>> = [];
  const auditLogs: Array<Record<string, unknown>> = [];

  const client = {
    user: {
      findFirst: async (args: { where: { telegramId?: bigint } }) =>
        args.where.telegramId === 1000n ? { id: row.userId, telegramId: 1000n } : null,
      findUnique: async () => null,
    },
    partner: {
      findUnique: async (args: { where: { userId?: string; id?: string } }) =>
        partners.find((p) =>
          args.where.id !== undefined ? p.id === args.where.id : p.userId === args.where.userId,
        ) ?? null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const target = partners.find((p) => p.id === args.where.id);
        if (!target) throw new Error('fake prisma: partner.update on a missing row');
        updates.push(args.data);
        // Apply exactly the keys Prisma would apply — an absent key does not
        // touch the column, which is the behaviour under test.
        for (const [key, value] of Object.entries(args.data)) {
          (target as unknown as Record<string, unknown>)[key] = value;
        }
        target.updatedAt = new Date();
        return { ...target };
      },
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditLogs.push(args.data);
        return args.data;
      },
    },
  };

  return { client, updates, auditLogs, row: partners[0] as PartnerRow };
}

function buildController(db: ReturnType<typeof makeDb>): AdminUserManagementController {
  return new AdminUserManagementController(
    db.client as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    {} as never, // PartnerEarningsService
    {} as never, // ReferralManualAttachService
    {} as never, // ReferralQualificationService
    {} as never, // StealthnetReferralSyncService
    {} as never, // ReferralInviteLimitsService
    {} as never, // RemnawaveApiService
    {} as never, // UserNotificationsService
    {} as never, // RbacService
    {} as never, // UserDeletionService
    {} as never, // PartnersService
    {} as never, // PlansAdminService
    undefined as never,
    { listForUser: async () => [], clear: async () => undefined } as never, // DeviceIntelligenceService
  );
}

/** The production pipe, byte for byte — see `src/main.ts`. */
const PRODUCTION_PIPE = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

async function throughPipe(body: unknown): Promise<UpdatePartnerSettingsDto> {
  return (await PRODUCTION_PIPE.transform(body, {
    type: 'body',
    metatype: UpdatePartnerSettingsDto,
  })) as UpdatePartnerSettingsDto;
}

// ── The DTO must be able to SAY "omitted" and "explicitly null" ──────────────
//
// If the pipe collapsed `null` into `undefined` (or stripped the key), the
// controller could not distinguish "leave this level alone" from "clear this
// level back to inherit" no matter how it were written. Verified here rather
// than assumed, through the same pipe main.ts installs.

describe('UpdatePartnerSettingsDto — omitted vs explicit null', () => {
  it('an omitted level leaves the property ABSENT, not null', async () => {
    const dto = await throughPipe({ useGlobalSettings: false });

    assert.equal('level1AccrualStrategy' in dto, false);
    assert.equal(dto.level1AccrualStrategy, undefined);
    assert.equal(dto.level2AccrualStrategy, undefined);
    assert.equal(dto.level3AccrualStrategy, undefined);
  });

  it('an explicit null SURVIVES the pipe as null on all three levels', async () => {
    const dto = await throughPipe({
      level1AccrualStrategy: null,
      level2AccrualStrategy: null,
      level3AccrualStrategy: null,
    });

    assert.equal('level1AccrualStrategy' in dto, true);
    assert.equal(dto.level1AccrualStrategy, null);
    assert.equal(dto.level2AccrualStrategy, null);
    assert.equal(dto.level3AccrualStrategy, null);
  });

  it('accepts both enum members and rejects anything else', async () => {
    const dto = await throughPipe({
      level1AccrualStrategy: 'ONCE_PER_USER',
      level2AccrualStrategy: 'ON_EACH_PAYMENT',
    });
    assert.equal(dto.level1AccrualStrategy, PartnerAccrualStrategy.ONCE_PER_USER);
    assert.equal(dto.level2AccrualStrategy, PartnerAccrualStrategy.ON_EACH_PAYMENT);

    // `ON_FIRST_PAYMENT` is the GLOBAL settings-JSON spelling. The per-partner
    // column is a Prisma enum whose first-payment member is `ONCE_PER_USER`,
    // so posting the global spelling here must be rejected, not stored.
    await assert.rejects(
      () => throughPipe({ level3AccrualStrategy: 'ON_FIRST_PAYMENT' }),
      (error: unknown) => {
        const response = (error as { getResponse?: () => unknown }).getResponse?.() as
          | { message?: string[] }
          | undefined;
        assert.equal(
          (response?.message ?? []).some((m) => m.includes('level3AccrualStrategy')),
          true,
          'the validation error must name the field it rejected',
        );
        return true;
      },
    );
  });
});

// ── Control ─────────────────────────────────────────────────────────────────
//
// Every assertion below reads `db.updates[0]`. If the fake could not record an
// update at all, "the field is missing from data" would pass for the wrong
// reason. This proves a field that was ALWAYS wired reaches the fake.

describe('partner settings PATCH — the fake records the write (control)', () => {
  it('an existing field (level1FixedAmount) reaches partner.update.data', async () => {
    const db = makeDb(makePartnerRow());
    const controller = buildController(db);

    await controller.updatePartnerSettings(
      '1000',
      { level1FixedAmount: 25000 } as UpdatePartnerSettingsDto,
      ADMIN,
      REQ,
    );

    assert.equal(db.updates.length, 1);
    assert.deepEqual(db.updates[0], { level1FixedAmount: 25000 });
    assert.equal(db.row.level1FixedAmount, 25000);
  });
});

// ── 1. The three fields are persisted ───────────────────────────────────────

describe('partner settings PATCH — per-level accrual strategy is persisted', () => {
  it('writes level1AccrualStrategy into the Prisma data object', async () => {
    const db = makeDb(makePartnerRow());
    const controller = buildController(db);

    await controller.updatePartnerSettings(
      '1000',
      { level1AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER } as UpdatePartnerSettingsDto,
      ADMIN,
      REQ,
    );

    assert.equal(db.updates.length, 1);
    assert.deepEqual(db.updates[0], {
      level1AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
    });
    assert.equal(db.row.level1AccrualStrategy, PartnerAccrualStrategy.ONCE_PER_USER);
  });

  it('writes level2AccrualStrategy into the Prisma data object', async () => {
    const db = makeDb(makePartnerRow());
    const controller = buildController(db);

    await controller.updatePartnerSettings(
      '1000',
      { level2AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER } as UpdatePartnerSettingsDto,
      ADMIN,
      REQ,
    );

    assert.deepEqual(db.updates[0], {
      level2AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
    });
    assert.equal(db.row.level2AccrualStrategy, PartnerAccrualStrategy.ONCE_PER_USER);
  });

  it('writes level3AccrualStrategy into the Prisma data object', async () => {
    const db = makeDb(makePartnerRow());
    const controller = buildController(db);

    await controller.updatePartnerSettings(
      '1000',
      { level3AccrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT } as UpdatePartnerSettingsDto,
      ADMIN,
      REQ,
    );

    assert.deepEqual(db.updates[0], {
      level3AccrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
    });
    assert.equal(db.row.level3AccrualStrategy, PartnerAccrualStrategy.ON_EACH_PAYMENT);
  });

  it('carries all three at once alongside the fields that already worked', async () => {
    const db = makeDb(makePartnerRow());
    const controller = buildController(db);

    await controller.updatePartnerSettings(
      '1000',
      {
        useGlobalSettings: false,
        accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
        level1FixedAmount: 10000,
        level1AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
        level2AccrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
        level3AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
      } as UpdatePartnerSettingsDto,
      ADMIN,
      REQ,
    );

    assert.deepEqual(db.updates[0], {
      useGlobalSettings: false,
      accrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
      level1FixedAmount: 10000,
      level1AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
      level2AccrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
      level3AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
    });
    assert.deepEqual(
      [db.row.level1AccrualStrategy, db.row.level2AccrualStrategy, db.row.level3AccrualStrategy],
      [
        PartnerAccrualStrategy.ONCE_PER_USER,
        PartnerAccrualStrategy.ON_EACH_PAYMENT,
        PartnerAccrualStrategy.ONCE_PER_USER,
      ],
    );
  });

  it('names the per-level keys in the audit trail it writes', async () => {
    const db = makeDb(makePartnerRow());
    const controller = buildController(db);

    await controller.updatePartnerSettings(
      '1000',
      { level2AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER } as UpdatePartnerSettingsDto,
      ADMIN,
      REQ,
    );

    const metadata = db.auditLogs[0]?.['metadata'] as { changes?: string[] } | undefined;
    assert.deepEqual(metadata?.changes, ['level2AccrualStrategy']);
  });
});

// ── 2. An omitted field must leave the column untouched ─────────────────────

describe('partner settings PATCH — an omitted level is left alone', () => {
  it('does not put an omitted level in the Prisma data object at all', async () => {
    const db = makeDb(
      makePartnerRow({
        level1AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
        level2AccrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
        level3AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
      }),
    );
    const controller = buildController(db);

    // Only level 2 is in the request. Levels 1 and 3 are absent.
    await controller.updatePartnerSettings(
      '1000',
      { level2AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER } as UpdatePartnerSettingsDto,
      ADMIN,
      REQ,
    );

    const data = db.updates[0] as Record<string, unknown>;
    assert.equal('level1AccrualStrategy' in data, false);
    assert.equal('level3AccrualStrategy' in data, false);
    assert.deepEqual(Object.keys(data), ['level2AccrualStrategy']);
  });

  it('leaves the stored value of an omitted level exactly as it was', async () => {
    const db = makeDb(
      makePartnerRow({
        level1AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
        level3AccrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
      }),
    );
    const controller = buildController(db);

    await controller.updatePartnerSettings(
      '1000',
      { level2AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER } as UpdatePartnerSettingsDto,
      ADMIN,
      REQ,
    );

    assert.equal(db.row.level1AccrualStrategy, PartnerAccrualStrategy.ONCE_PER_USER);
    assert.equal(db.row.level3AccrualStrategy, PartnerAccrualStrategy.ON_EACH_PAYMENT);
  });
});

// ── 3. An explicit null must CLEAR the column back to inherit ───────────────

describe('partner settings PATCH — an explicit null clears the level to inherit', () => {
  it('writes null into the Prisma data object for a level sent as null', async () => {
    const db = makeDb(
      makePartnerRow({ level1AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER }),
    );
    const controller = buildController(db);

    await controller.updatePartnerSettings(
      '1000',
      { level1AccrualStrategy: null } as UpdatePartnerSettingsDto,
      ADMIN,
      REQ,
    );

    const data = db.updates[0] as Record<string, unknown>;
    assert.equal(
      'level1AccrualStrategy' in data,
      true,
      'null must reach Prisma as a written key — dropping it is the "omitted" request, a different one',
    );
    assert.equal(data['level1AccrualStrategy'], null);
    assert.equal(db.row.level1AccrualStrategy, null);
  });

  it('clears all three levels back to inherit in one request', async () => {
    const db = makeDb(
      makePartnerRow({
        level1AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
        level2AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
        level3AccrualStrategy: PartnerAccrualStrategy.ON_EACH_PAYMENT,
      }),
    );
    const controller = buildController(db);

    await controller.updatePartnerSettings(
      '1000',
      {
        level1AccrualStrategy: null,
        level2AccrualStrategy: null,
        level3AccrualStrategy: null,
      } as UpdatePartnerSettingsDto,
      ADMIN,
      REQ,
    );

    assert.deepEqual(db.updates[0], {
      level1AccrualStrategy: null,
      level2AccrualStrategy: null,
      level3AccrualStrategy: null,
    });
    assert.deepEqual(
      [db.row.level1AccrualStrategy, db.row.level2AccrualStrategy, db.row.level3AccrualStrategy],
      [null, null, null],
    );
  });

  it('"clear to inherit" and "leave alone" are different requests, not the same one', async () => {
    // The whole point of the `!== undefined` guard. Send level 1 as null and
    // omit level 2, from the same starting row, and the two columns must end
    // up in different states.
    const stored = makePartnerRow({
      level1AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
      level2AccrualStrategy: PartnerAccrualStrategy.ONCE_PER_USER,
    });
    const db = makeDb(stored);
    const controller = buildController(db);

    await controller.updatePartnerSettings(
      '1000',
      { level1AccrualStrategy: null } as UpdatePartnerSettingsDto,
      ADMIN,
      REQ,
    );

    assert.equal(db.row.level1AccrualStrategy, null, 'sent as null → cleared to inherit');
    assert.equal(
      db.row.level2AccrualStrategy,
      PartnerAccrualStrategy.ONCE_PER_USER,
      'omitted → untouched',
    );
  });
});
