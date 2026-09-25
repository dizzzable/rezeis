import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { BadRequestException, ConflictException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ConfigType } from '@nestjs/config';
import { UserRole, type Prisma, type Settings } from '@prisma/client';

import type { appConfig } from '../src/common/config/app.config';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { AdminAddOnSwitchesController } from '../src/modules/add-on-entitlements/switches/admin-add-on-switches.controller';
import {
  ADD_ON_SWITCH_OFF_NOT_CONFIRMED,
  ADD_ON_SWITCH_SET_IN_ENV,
  AddOnSwitchesService,
} from '../src/modules/add-on-entitlements/switches/add-on-switches.service';
import { UpdateAddOnSwitchesDto } from '../src/modules/add-on-entitlements/switches/update-add-on-switches.dto';
import { ADD_ON_ROLLOUT_FLAG_NAMES } from '../src/modules/add-on-entitlements/add-on-rollout.config';
import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { REQUIRE_PERMISSION_KEY } from '../src/modules/rbac/decorators/require-permission.decorator';
import type { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';

/**
 * «Доп. услуги» → «Настройки»: the switches, as the API and the worker read them
 * ═══════════════════════════════════════════════════════════════════════════
 * Everything here runs the REAL `SettingsService` row cache and the REAL
 * `mutateSettingsRow`, over a fake Prisma that holds one row. That is the
 * whole "no restart" promise: a save bumps this process's settings-write
 * generation, so this process reads it at once; the other process only sees
 * the row change underneath its cache, and must pick it up when that cache's
 * five seconds run out.
 *
 * The other process is simulated the only way one process can be: the row is
 * changed in the fake database directly, which is exactly what a commit made
 * elsewhere looks like from here — the row moves, this generation does not.
 */

const CRYPT_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const ADMIN: CurrentAdminInterface = {
  id: 'admin-switches',
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
  requestId: 'request-add-on-switches',
  remoteAddress: '203.0.113.30',
  userAgent: 'add-on-switches-spec',
} as const;

interface World {
  /** The committed row. Only the columns these paths read are real. */
  row: { id: number; addOnSettings: Prisma.JsonValue; updatedAt: Date };
  /** Reads of the row outside a write: the cache's misses. */
  reads: number;
  /** Row locks taken (`SELECT … FOR UPDATE`). */
  locks: number;
  readonly writes: Prisma.SettingsUpdateInput[];
  readonly audits: Prisma.AdminAuditLogCreateInput[];
}

function world(addOnSettings: Prisma.JsonValue = {}): { readonly db: World; readonly prisma: PrismaService } {
  const db: World = {
    row: { id: 1, addOnSettings, updatedAt: new Date('2026-09-24T10:00:00.000Z') },
    reads: 0,
    locks: 0,
    writes: [],
    audits: [],
  };
  const asRow = (): Settings => ({ ...db.row }) as unknown as Settings;
  const tx = {
    $queryRaw: async () => {
      db.locks += 1;
      return [{ id: db.row.id }];
    },
    settings: {
      findFirst: async () => asRow(),
      update: async (args: Prisma.SettingsUpdateArgs) => {
        db.writes.push(args.data);
        db.row = {
          ...db.row,
          addOnSettings: (args.data.addOnSettings ?? db.row.addOnSettings) as Prisma.JsonValue,
          updatedAt: new Date(),
        };
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
    settings: {
      findFirst: async () => {
        db.reads += 1;
        return asRow();
      },
    },
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx),
  };
  return { db, prisma: prisma as unknown as PrismaService };
}

/** One panel process: its own `SettingsService` (and row cache) and its own switches service. */
function processOver(prisma: PrismaService): AddOnSwitchesService {
  const settings = new SettingsService(
    prisma,
    {} as IconUploadService,
    { cryptKey: CRYPT_KEY } as ConfigType<typeof appConfig>,
  );
  return new AddOnSwitchesService(prisma, settings);
}

function change(
  service: AddOnSwitchesService,
  changes: Parameters<AddOnSwitchesService['update']>[0]['changes'],
  confirmOff: boolean,
) {
  return service.update({ currentAdmin: ADMIN, requestMetadata: REQUEST_METADATA, changes, confirmOff });
}

/** Runs `body` with no `ADDON_*` variable set except `set`, and puts the environment back. */
async function withEnv<T>(set: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const saved = new Map(ADD_ON_ROLLOUT_FLAG_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ADD_ON_ROLLOUT_FLAG_NAMES) delete process.env[name];
  Object.assign(process.env, set);
  try {
    return await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('AddOnSwitchesService — what the panel runs with', () => {
  it('runs on the defaults while the row holds no switch: stages 1, 2, 4 and 6 ON (stage 4 since 25.09.2026)', async () => {
    await withEnv({}, async () => {
      const { prisma } = world();
      assert.deepEqual(await processOver(prisma).flags(), {
        entitlementShadow: true,
        directPurchase: true,
        deviceCleanupAuto: true,
        resetExpiry: { DAY: true, WEEK: true, MONTH: true, MONTH_ROLLING: true },
      });
    });
  });

  it('a switch saved on the page reaches the process that saved it at once', async () => {
    await withEnv({}, async () => {
      const { db, prisma } = world();
      const api = processOver(prisma);
      assert.equal((await api.flags()).deviceCleanupAuto, true);
      const readsBefore = db.reads;

      await change(api, { deviceCleanupAuto: false }, true);

      assert.equal((await api.flags()).deviceCleanupAuto, false, 'the save must not be answered from the cached row');
      assert.ok(db.reads > readsBefore, 'the read after the save went to the database');
    });
  });

  it('the other process sees a save within the row cache five seconds, with no restart', async () => {
    await withEnv({}, async () => {
      const { db, prisma } = world();
      let now = Date.parse('2026-09-24T12:00:00.000Z');
      mock.method(Date, 'now', () => now);
      try {
        const worker = processOver(prisma);
        assert.equal((await worker.flags()).directPurchase, true);
        const reads = db.reads;

        // The API process saves «Новый учёт докупок» OFF: the row changes,
        // this process's generation does not.
        db.row = { ...db.row, addOnSettings: { durableAccounting: false } };

        now += 4_999;
        assert.equal((await worker.flags()).directPurchase, true, 'inside the window the cached row answers');
        assert.equal(db.reads, reads, 'a read inside the window costs no query');

        now += 1;
        const flags = await worker.flags();
        assert.equal(flags.directPurchase, false, 'five seconds on, the worker runs with the switch as saved');
        assert.equal(flags.entitlementShadow, false);
        assert.equal(db.reads, reads + 1);
      } finally {
        mock.restoreAll();
      }
    });
  });

  it('an explicit .env value wins over the stored switch', async () => {
    const { prisma } = world({ deviceCleanupAuto: true, trafficResetExpiry: false });
    await withEnv({ ADDON_DEVICE_CLEANUP_AUTO: 'false', ADDON_RESET_EXPIRY_MONTH: 'on' }, async () => {
      const flags = await processOver(prisma).flags();
      assert.equal(flags.deviceCleanupAuto, false);
      assert.equal(flags.resetExpiry.MONTH, true);
      assert.equal(flags.resetExpiry.DAY, false);
    });
  });
});

describe('AddOnSwitchesService — a change from the page', () => {
  it('refuses a switch .env decides, naming the variable, and writes nothing', async () => {
    const { db, prisma } = world({ deviceCleanupAuto: true });
    await withEnv({ ADDON_DEVICE_CLEANUP_AUTO: 'false' }, async () => {
      const api = processOver(prisma);
      const view = await api.view();
      assert.deepEqual(view.switches[1], {
        name: 'deviceCleanupAuto',
        enabled: false,
        defaultEnabled: true,
        stored: true,
        env: [{ variable: 'ADDON_DEVICE_CLEANUP_AUTO', enabled: false }],
      });

      await assert.rejects(change(api, { deviceCleanupAuto: true }, false), (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        const body = error.getResponse() as Record<string, unknown>;
        assert.equal(body['code'], ADD_ON_SWITCH_SET_IN_ENV);
        assert.equal(body['switch'], 'deviceCleanupAuto');
        assert.deepEqual(body['variables'], ['ADDON_DEVICE_CLEANUP_AUTO']);
        return true;
      });
      assert.deepEqual(db.writes, []);
      assert.deepEqual(db.audits, []);
    });
  });

  it('refuses to switch a stage OFF without the confirmation, and writes nothing', async () => {
    await withEnv({}, async () => {
      const { db, prisma } = world();
      const api = processOver(prisma);
      await assert.rejects(change(api, { durableAccounting: false }, false), (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        const body = error.getResponse() as Record<string, unknown>;
        assert.equal(body['code'], ADD_ON_SWITCH_OFF_NOT_CONFIRMED);
        assert.equal(body['switch'], 'durableAccounting');
        return true;
      });
      assert.deepEqual(db.writes, []);
      assert.deepEqual(db.audits, []);
      assert.equal((await api.flags()).entitlementShadow, true);
    });
  });

  it('writes a confirmed switch-off under the row lock, with an audit row, keeping the other stored switches', async () => {
    await withEnv({}, async () => {
      const { db, prisma } = world({ trafficResetExpiry: true });
      const api = processOver(prisma);

      const view = await change(api, { durableAccounting: false }, true);

      assert.ok(db.locks >= 1, 'the write must hold the settings row lock');
      assert.deepEqual(db.writes, [{ addOnSettings: { trafficResetExpiry: true, durableAccounting: false } }]);
      assert.equal(db.audits.length, 1);
      assert.equal(db.audits[0]!.action, 'settings.addOnSwitches.update');
      assert.deepEqual(db.audits[0]!.adminUser, { connect: { id: ADMIN.id } });
      assert.deepEqual((db.audits[0]!.metadata as Record<string, unknown>)['changed'], { durableAccounting: false });
      // The answer is what `flags()` now runs with.
      assert.deepEqual(view.switches[0], {
        name: 'durableAccounting',
        enabled: false,
        defaultEnabled: true,
        stored: false,
        env: [],
      });
      assert.equal(view.switches[2]!.enabled, true);
    });
  });

  it('turns a switch ON without asking', async () => {
    await withEnv({}, async () => {
      // An OFF saved on the page earlier (confirmed then): ON is the default
      // now, so only a stored OFF leaves a switch to turn back on.
      const { db, prisma } = world({ trafficResetExpiry: false });
      const api = processOver(prisma);
      assert.deepEqual((await api.flags()).resetExpiry, { DAY: false, WEEK: false, MONTH: false, MONTH_ROLLING: false });
      const view = await change(api, { trafficResetExpiry: true }, false);
      assert.deepEqual(db.writes, [{ addOnSettings: { trafficResetExpiry: true } }]);
      assert.equal(view.switches[2]!.enabled, true);
      assert.deepEqual((await api.flags()).resetExpiry, { DAY: true, WEEK: true, MONTH: true, MONTH_ROLLING: true });
    });
  });

  it('writes nothing, and audits nothing, when no switch moves', async () => {
    await withEnv({}, async () => {
      const { db, prisma } = world({ deviceCleanupAuto: false });
      const view = await change(processOver(prisma), { deviceCleanupAuto: false, durableAccounting: true }, false);
      assert.deepEqual(db.writes, []);
      assert.deepEqual(db.audits, []);
      assert.equal(view.switches[1]!.enabled, false);
    });
  });
});

describe('/admin/add-on-settings', () => {
  it('is read with «Доп. услуги» → view and changed only with «Доп. услуги» → edit', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminAddOnSwitchesController), 'admin/add-on-settings');
    const read = AdminAddOnSwitchesController.prototype.view;
    const write = AdminAddOnSwitchesController.prototype.update;
    assert.equal(Reflect.getMetadata(METHOD_METADATA, read), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(METHOD_METADATA, write), RequestMethod.PATCH);
    assert.deepEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, AdminAddOnSwitchesController), [
      { resource: 'add_ons', action: 'view' },
    ]);
    assert.equal(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, read), undefined, 'GET takes the controller-level view');
    // The guard reads method over controller (`getAllAndOverride`): edit replaces view.
    assert.deepEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, write), [{ resource: 'add_ons', action: 'edit' }]);
  });

  it('passes on only the switches the body names, and the confirmation', async () => {
    const calls: unknown[] = [];
    const controller = new AdminAddOnSwitchesController({
      update: async (input: unknown) => {
        calls.push(input);
        return { switches: [] };
      },
    } as unknown as AddOnSwitchesService);
    const request = { headers: {}, ip: '203.0.113.31', socket: { remoteAddress: '203.0.113.31' } } as never;
    await controller.update({ deviceCleanupAuto: false, confirmOff: true }, ADMIN, request);
    await controller.update({ trafficResetExpiry: true }, ADMIN, request);
    const [first, second] = calls as Array<{ changes: unknown; confirmOff: boolean }>;
    assert.deepEqual(first!.changes, { deviceCleanupAuto: false });
    assert.equal(first!.confirmOff, true);
    assert.deepEqual(second!.changes, { trafficResetExpiry: true });
    assert.equal(second!.confirmOff, false, 'no confirmation unless the body says so');
  });

  it('takes a JSON boolean only, and no switch it does not know', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
    const through = (body: unknown) => pipe.transform(body, { type: 'body', metatype: UpdateAddOnSwitchesDto });

    const ok = (await through({ durableAccounting: false, confirmOff: true })) as UpdateAddOnSwitchesDto;
    assert.equal(ok.durableAccounting, false);
    assert.equal(ok.confirmOff, true);
    // The string "false" must not arrive as a truthy value: refused outright.
    await assert.rejects(through({ durableAccounting: 'false' }), BadRequestException);
    // Stages 3 and 5 have no switch any more.
    await assert.rejects(through({ projectionSync: true }), BadRequestException);
    await assert.rejects(through({ renewalAddOns: true }), BadRequestException);
  });
});
