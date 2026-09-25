import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { ConfigType } from '@nestjs/config';
import { Prisma, UserRole } from '@prisma/client';

import type { appConfig } from '../src/common/config/app.config';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ADD_ON_ROLLOUT_FLAG_NAMES } from '../src/modules/add-on-entitlements/add-on-rollout.config';
import { AddOnSwitchesService } from '../src/modules/add-on-entitlements/switches/add-on-switches.service';
import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import type { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import { ensureSettingsRow } from '../src/modules/settings/utils/settings-row-write.util';

/**
 * «Доп. услуги» → «Настройки» on a real PostgreSQL: the column the migration
 * adds, a save as it commits, and what a process that did not make the save
 * runs with afterwards. The row cache itself — the five seconds, the
 * generation — is pinned by `add-on-switches.service.spec.ts`; what only a
 * database can show is that the column is there with the default every
 * existing install is read through, and that two saves at once both land.
 *
 * ISOLATION. The settings row is shared by every spec on the database; its
 * `add_on_settings` is put back as it was.
 *
 * Runs only with TEST_DATABASE_URL; listed in the PostgreSQL job of ci.yml.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `aosw-${process.pid}-${Date.now()}`;
const CRYPT_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const REQUEST_METADATA = {
  requestId: `${prefix}-request`,
  remoteAddress: '203.0.113.40',
  userAgent: 'add-on-switches-postgres-spec',
} as const;

let prisma: PrismaService;
let savedSwitches: unknown = {};
let admin: CurrentAdminInterface;
const savedEnv = new Map<string, string | undefined>();

/** A panel process: its own settings row cache, empty. */
function processOver(client: PrismaService): AddOnSwitchesService {
  const settings = new SettingsService(
    client,
    {} as IconUploadService,
    { cryptKey: CRYPT_KEY } as ConfigType<typeof appConfig>,
  );
  return new AddOnSwitchesService(client, settings);
}

async function storedSwitches(): Promise<unknown> {
  const rows = await prisma.$queryRaw<Array<{ readonly value: unknown }>>(
    Prisma.sql`SELECT "add_on_settings" AS "value" FROM "settings" ORDER BY "id" LIMIT 1`,
  );
  return rows[0]?.value;
}

async function setStoredSwitches(value: unknown): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`UPDATE "settings" SET "add_on_settings" = ${JSON.stringify(value)}::jsonb`);
}

run('add-on switches on a real database', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    // `.env` decides nothing in this file: the switches do.
    for (const name of ADD_ON_ROLLOUT_FLAG_NAMES) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    prisma = new PrismaService();
    await prisma.$connect();
    await ensureSettingsRow(prisma);
    savedSwitches = (await storedSwitches()) ?? {};
    const created = await prisma.adminUser.create({
      data: { login: `${prefix}-admin`, loginNormalized: `${prefix}-admin`, passwordHash: 'not-a-hash' },
    });
    admin = {
      id: created.id,
      login: created.login,
      email: null,
      name: null,
      role: UserRole.ADMIN,
      isActive: true,
      tokenVersion: 1,
      createdAt: created.createdAt,
      lastLoginAt: null,
      lastLoginIp: null,
      rbacRoleId: null,
      mustChangePassword: false,
    };
  });

  after(async () => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (prisma === undefined) return;
    await setStoredSwitches(savedSwitches).catch(() => undefined);
    await prisma.adminAuditLog.deleteMany({ where: { adminUserId: admin.id } }).catch(() => undefined);
    await prisma.adminUser.deleteMany({ where: { id: admin.id } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('the column is there, NOT NULL, with the empty object every existing row is read through', async () => {
    const columns = await prisma.$queryRaw<
      Array<{ readonly data_type: string; readonly is_nullable: string; readonly column_default: string | null }>
    >(Prisma.sql`
      SELECT "data_type", "is_nullable", "column_default"
      FROM "information_schema"."columns"
      WHERE "table_name" = 'settings' AND "column_name" = 'add_on_settings'
    `);
    assert.equal(columns.length, 1);
    assert.equal(columns[0]!.data_type, 'jsonb');
    assert.equal(columns[0]!.is_nullable, 'NO');
    assert.match(columns[0]!.column_default ?? '', /^'\{\}'::jsonb$/);

    // `{}` is "never set": the defaults — every stage ON, stage 4 since 25.09.2026.
    await setStoredSwitches({});
    assert.deepEqual(await processOver(prisma).flags(), {
      entitlementShadow: true,
      directPurchase: true,
      deviceCleanupAuto: true,
      resetExpiry: { DAY: true, WEEK: true, MONTH: true, MONTH_ROLLING: true },
    });
  });

  it('a confirmed switch-off commits with its audit row, and a process that did not make it runs with it', async () => {
    await setStoredSwitches({});
    await processOver(prisma).update({
      currentAdmin: admin,
      requestMetadata: REQUEST_METADATA,
      changes: { deviceCleanupAuto: false },
      confirmOff: true,
    });

    assert.deepEqual(await storedSwitches(), { deviceCleanupAuto: false });
    const audits = await prisma.adminAuditLog.findMany({
      where: { adminUserId: admin.id, action: 'settings.addOnSwitches.update' },
      select: { metadata: true },
    });
    assert.equal(audits.length, 1);
    assert.deepEqual((audits[0]!.metadata as Record<string, unknown>)['changed'], { deviceCleanupAuto: false });

    const elsewhere = await processOver(prisma).flags();
    assert.equal(elsewhere.deviceCleanupAuto, false);
    assert.equal(elsewhere.entitlementShadow, true);
  });

  it('two operators saving different switches at once both keep their change', async () => {
    await setStoredSwitches({});
    // Each save reads the row under `SELECT … FOR UPDATE` and merges its own
    // key onto it; without the lock the second commit would write its copy of
    // the column over the first one's change.
    await Promise.all([
      processOver(prisma).update({
        currentAdmin: admin,
        requestMetadata: REQUEST_METADATA,
        changes: { durableAccounting: false },
        confirmOff: true,
      }),
      // A real change too: ON is the default, so the other operator switches
      // stage 4 OFF (confirmed) rather than ON.
      processOver(prisma).update({
        currentAdmin: admin,
        requestMetadata: REQUEST_METADATA,
        changes: { trafficResetExpiry: false },
        confirmOff: true,
      }),
    ]);
    assert.deepEqual(await storedSwitches(), { durableAccounting: false, trafficResetExpiry: false });
  });
});
