import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { UserRole, type Prisma, type Settings } from '@prisma/client';

import type { appConfig } from '../src/common/config/app.config';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import {
  ADD_ON_ROLLOUT_FLAG_NAMES,
  readStoredRemnawaveTimeZone,
} from '../src/modules/add-on-entitlements/add-on-rollout.config';
import { AdminAddOnSwitchesController } from '../src/modules/add-on-entitlements/switches/admin-add-on-switches.controller';
import {
  AddOnSwitchesService,
  mergeAddOnSettings,
} from '../src/modules/add-on-entitlements/switches/add-on-switches.service';
import {
  ADD_ON_TIME_ZONE_INVALID,
  normalizeRemnawaveTimeZoneInput,
  RemnawaveTimeZoneInputError,
} from '../src/modules/add-on-entitlements/switches/remnawave-time-zone';
import { UpdateAddOnSwitchesDto } from '../src/modules/add-on-entitlements/switches/update-add-on-switches.dto';
import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import type { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';

/**
 * «Часовой пояс Remnawave» — stored beside the switches, read with them
 * ═══════════════════════════════════════════════════════════════════
 * The zone lives in the same JSON column as the three switches
 * (`settings.add_on_settings`), and that is the trap this spec is about: the
 * switch writer plans only the switches, so a save that writes its plan as the
 * whole column erases the zone, and a zone save built the same way erases the
 * switches. Everything runs the REAL `SettingsService` row cache and the REAL
 * `mutateSettingsRow` over a fake Prisma holding one row, as the switches'
 * own spec does.
 */

const CRYPT_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const ADMIN: CurrentAdminInterface = {
  id: 'admin-zone',
  login: 'admin',
  email: 'admin@example.test',
  name: 'Admin',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: null,
  mustChangePassword: false,
};

const REQUEST_METADATA = {
  requestId: 'request-remnawave-zone',
  remoteAddress: '203.0.113.40',
  userAgent: 'remnawave-zone-spec',
} as const;

interface World {
  row: { id: number; addOnSettings: Prisma.JsonValue; updatedAt: Date };
  readonly writes: Prisma.SettingsUpdateInput[];
  readonly audits: Prisma.AdminAuditLogCreateInput[];
}

function world(addOnSettings: Prisma.JsonValue = {}): { readonly db: World; readonly service: AddOnSwitchesService } {
  const db: World = {
    row: { id: 1, addOnSettings, updatedAt: new Date('2026-09-25T06:00:00.000Z') },
    writes: [],
    audits: [],
  };
  const asRow = (): Settings => ({ ...db.row }) as unknown as Settings;
  const tx = {
    $queryRaw: async () => [{ id: db.row.id }],
    settings: {
      findFirst: async () => asRow(),
      update: async (args: Prisma.SettingsUpdateArgs) => {
        db.writes.push(args.data);
        db.row = { ...db.row, addOnSettings: (args.data.addOnSettings ?? db.row.addOnSettings) as Prisma.JsonValue };
        return asRow();
      },
    },
    adminAuditLog: {
      create: async (args: Prisma.AdminAuditLogCreateArgs) => {
        db.audits.push(args.data as Prisma.AdminAuditLogCreateInput);
        return {};
      },
    },
  };
  const prisma = {
    settings: { findFirst: async () => asRow() },
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx),
  } as unknown as PrismaService;
  const settings = new SettingsService(prisma, {} as IconUploadService, { cryptKey: CRYPT_KEY } as ConfigType<typeof appConfig>);
  return { db, service: new AddOnSwitchesService(prisma, settings) };
}

function save(service: AddOnSwitchesService, input: Partial<Parameters<AddOnSwitchesService['update']>[0]>) {
  return service.update({
    currentAdmin: ADMIN,
    requestMetadata: REQUEST_METADATA,
    changes: {},
    confirmOff: false,
    ...input,
  });
}

async function withEnv<T>(body: () => Promise<T>): Promise<T> {
  const saved = new Map(ADD_ON_ROLLOUT_FLAG_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ADD_ON_ROLLOUT_FLAG_NAMES) delete process.env[name];
  try {
    return await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('«Часовой пояс Remnawave» — what the panel runs with', () => {
  it('rides in the flags snapshot, from the same row read as the switches', async () => {
    await withEnv(async () => {
      const { service } = world({ trafficResetExpiry: true, remnawaveTimeZone: 'Europe/Moscow' });
      const flags = await service.flags();
      assert.equal(flags.remnawaveTimeZone, 'Europe/Moscow');
      assert.equal(flags.resetExpiry.DAY, true, 'the switch beside it is read from the same row');
    });
  });

  it('is UTC while never set: the snapshot carries no zone', async () => {
    await withEnv(async () => {
      const { service } = world({ trafficResetExpiry: true });
      const flags = await service.flags();
      assert.equal('remnawaveTimeZone' in flags, false);
      const view = await service.view();
      assert.deepEqual(view.remnawaveTimeZone, { value: 'UTC', stored: null, defaultValue: 'UTC' });
    });
  });

  it('shows the stored zone on the page', async () => {
    await withEnv(async () => {
      const { service } = world({ remnawaveTimeZone: 'Asia/Yekaterinburg' });
      const view = await service.view();
      assert.deepEqual(view.remnawaveTimeZone, {
        value: 'Asia/Yekaterinburg',
        stored: 'Asia/Yekaterinburg',
        defaultValue: 'UTC',
      });
    });
  });
});

describe('«Часовой пояс Remnawave» — one column, two writers', () => {
  it('a switch save keeps the zone stored beside it', async () => {
    await withEnv(async () => {
      // A stored OFF turned ON: a change whatever the defaults are.
      const { db, service } = world({ remnawaveTimeZone: 'Europe/Moscow', deviceCleanupAuto: false });
      await save(service, { changes: { deviceCleanupAuto: true } });
      assert.equal(db.writes.length, 1);
      assert.deepEqual(db.row.addOnSettings, { remnawaveTimeZone: 'Europe/Moscow', deviceCleanupAuto: true });
      assert.equal((await service.flags()).remnawaveTimeZone, 'Europe/Moscow');
    });
  });

  it('a zone save keeps the switches, and is what the flags then carry', async () => {
    await withEnv(async () => {
      const { db, service } = world({ durableAccounting: false, trafficResetExpiry: true });
      const view = await save(service, { remnawaveTimeZone: 'Asia/Novosibirsk' });
      assert.deepEqual(db.row.addOnSettings, {
        durableAccounting: false,
        trafficResetExpiry: true,
        remnawaveTimeZone: 'Asia/Novosibirsk',
      });
      assert.equal(view.remnawaveTimeZone.value, 'Asia/Novosibirsk');
      const flags = await service.flags();
      assert.equal(flags.remnawaveTimeZone, 'Asia/Novosibirsk');
      assert.equal(flags.directPurchase, false, 'the switch stored before the zone save still decides');
    });
  });

  it('keeps a key it does not know, whatever the save', async () => {
    const merged = mergeAddOnSettings({ somethingLater: 7, deviceCleanupAuto: false }, { deviceCleanupAuto: true }, 'UTC');
    assert.deepEqual(merged, { somethingLater: 7, deviceCleanupAuto: true, remnawaveTimeZone: 'UTC' });
  });

  it('an empty zone puts it back to UTC and keeps everything else', async () => {
    await withEnv(async () => {
      const { db, service } = world({ deviceCleanupAuto: false, remnawaveTimeZone: 'Europe/Moscow' });
      const view = await save(service, { remnawaveTimeZone: '  ' });
      assert.deepEqual(db.row.addOnSettings, { deviceCleanupAuto: false });
      assert.deepEqual(view.remnawaveTimeZone, { value: 'UTC', stored: null, defaultValue: 'UTC' });
      assert.equal('remnawaveTimeZone' in (await service.flags()), false);
    });
  });

  it('stores the canonical name and audits the move', async () => {
    await withEnv(async () => {
      const { db, service } = world({});
      await save(service, { remnawaveTimeZone: ' europe/moscow ' });
      assert.deepEqual(db.row.addOnSettings, { remnawaveTimeZone: 'Europe/Moscow' });
      assert.equal(db.audits.length, 1);
      assert.equal(db.audits[0]!.action, 'settings.addOnSwitches.update');
      assert.deepEqual((db.audits[0]!.metadata as Record<string, unknown>)['changed'], {
        remnawaveTimeZone: 'Europe/Moscow',
      });
    });
  });

  it('writes nothing when the zone does not move', async () => {
    await withEnv(async () => {
      const { db, service } = world({ remnawaveTimeZone: 'Europe/Moscow' });
      await save(service, { remnawaveTimeZone: 'Europe/Moscow' });
      // Back to UTC while it already is.
      const never = world({});
      await save(never.service, { remnawaveTimeZone: '' });
      assert.deepEqual(db.writes, []);
      assert.deepEqual(db.audits, []);
      assert.deepEqual(never.db.writes, []);
      assert.deepEqual(never.db.audits, []);
    });
  });

  it('refuses a zone it does not know, and writes nothing of the request — its switch neither', async () => {
    await withEnv(async () => {
      const { db, service } = world({ remnawaveTimeZone: 'Europe/Moscow' });
      await assert.rejects(
        save(service, { remnawaveTimeZone: 'Europe/Mosow', changes: { trafficResetExpiry: true } }),
        (error: unknown) => {
          assert.ok(error instanceof BadRequestException);
          const body = error.getResponse() as Record<string, unknown>;
          assert.equal(body['code'], ADD_ON_TIME_ZONE_INVALID);
          assert.match(String(body['message']), /Europe\/Mosow/);
          return true;
        },
      );
      assert.deepEqual(db.writes, []);
      assert.deepEqual(db.row.addOnSettings, { remnawaveTimeZone: 'Europe/Moscow' });
    });
  });
});

describe('the zone an operator may type', () => {
  it('takes IANA names, in any case, and answers the canonical spelling', () => {
    assert.equal(normalizeRemnawaveTimeZoneInput('UTC'), 'UTC');
    assert.equal(normalizeRemnawaveTimeZoneInput('Europe/Moscow'), 'Europe/Moscow');
    assert.equal(normalizeRemnawaveTimeZoneInput('europe/moscow'), 'Europe/Moscow');
    assert.equal(normalizeRemnawaveTimeZoneInput('Etc/GMT+3'), 'Etc/GMT+3');
    assert.equal(normalizeRemnawaveTimeZoneInput('America/Argentina/Salta'), 'America/Argentina/Salta');
  });

  it('reads an empty field as "back to UTC"', () => {
    assert.equal(normalizeRemnawaveTimeZoneInput(''), null);
    assert.equal(normalizeRemnawaveTimeZoneInput('   '), null);
  });

  it('refuses what Remnawave\'s TZ cannot be: offsets, unknown names, stray characters', () => {
    for (const input of ['+03:00', 'UTC+3', 'Europe/Mosow', 'Moscow', 'Europe/../Moscow', 'a'.repeat(65), 'Europe/Moscow;']) {
      assert.throws(() => normalizeRemnawaveTimeZoneInput(input), RemnawaveTimeZoneInputError, input);
    }
  });

  it('reads only a non-empty string back from the column (the one reader, in the rollout config)', () => {
    assert.equal(readStoredRemnawaveTimeZone({ remnawaveTimeZone: ' Asia/Tokyo ' }), 'Asia/Tokyo');
    assert.equal(readStoredRemnawaveTimeZone({ remnawaveTimeZone: '' }), undefined);
    assert.equal(readStoredRemnawaveTimeZone({ remnawaveTimeZone: 3 }), undefined);
    assert.equal(readStoredRemnawaveTimeZone(null), undefined);
    assert.equal(readStoredRemnawaveTimeZone([]), undefined);
  });
});

describe('/admin/add-on-settings — the zone field', () => {
  it('passes the zone on only when the body names it', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const controller = new AdminAddOnSwitchesController({
      update: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { switches: [] };
      },
    } as unknown as AddOnSwitchesService);
    const request = { headers: {}, ip: '203.0.113.41', socket: { remoteAddress: '203.0.113.41' } } as never;
    await controller.update({ remnawaveTimeZone: 'Europe/Moscow' }, ADMIN, request);
    await controller.update({ trafficResetExpiry: true }, ADMIN, request);
    await controller.update({ remnawaveTimeZone: '' }, ADMIN, request);
    assert.equal(calls[0]!['remnawaveTimeZone'], 'Europe/Moscow');
    assert.equal('remnawaveTimeZone' in calls[1]!, false, 'a switch save does not touch the zone');
    assert.equal(calls[2]!['remnawaveTimeZone'], '', 'an empty field is passed on, to reset it');
  });

  it('takes a string of at most 64 characters', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
    const through = (body: unknown) => pipe.transform(body, { type: 'body', metatype: UpdateAddOnSwitchesDto });
    const ok = (await through({ remnawaveTimeZone: 'Europe/Moscow' })) as UpdateAddOnSwitchesDto;
    assert.equal(ok.remnawaveTimeZone, 'Europe/Moscow');
    await assert.rejects(through({ remnawaveTimeZone: 3 }), BadRequestException);
    await assert.rejects(through({ remnawaveTimeZone: 'a'.repeat(65) }), BadRequestException);
  });
});
