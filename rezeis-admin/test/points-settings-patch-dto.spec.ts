import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { SettingsController } from '../src/modules/settings/controllers/settings.controller';
import { UpdatePointsSettingsDto } from '../src/modules/settings/dto/update-points-settings.dto';
import { SettingsService } from '../src/modules/settings/services/settings.service';

/**
 * PATCH /admin/settings/points, the way `referral-settings-patch-dto.spec.ts`
 * pins its sibling: the route's body metatype is asserted (a DTO that never
 * runs is the original defect), every body goes through the production pipe,
 * and the route-level cases run pipe → controller → the real `SettingsService`
 * → a fake Prisma that holds the row, asserting the JSON handed to
 * `settings.update` rather than a spy's call count.
 */
const PRODUCTION_PIPE = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

async function throughPipe(body: unknown): Promise<UpdatePointsSettingsDto> {
  return (await PRODUCTION_PIPE.transform(body, {
    type: 'body',
    metatype: UpdatePointsSettingsDto,
  })) as UpdatePointsSettingsDto;
}

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
  headers: { 'x-request-id': 'request-points-1' },
  ip: '203.0.113.10',
  socket: { remoteAddress: '203.0.113.10' },
} as never;

function makeSettingsDb(pointsSettings: Record<string, unknown>) {
  const row = {
    id: 'settings-1',
    pointsSettings,
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
        row.pointsSettings = args.data.pointsSettings as Record<string, unknown>;
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
  return { controller, service, updates, auditLogs, row };
}

describe('PATCH /admin/settings/points — the pipe actually runs on this route', () => {
  it('declares the DTO as its body metatype, not Object', () => {
    const paramTypes = Reflect.getMetadata(
      'design:paramtypes',
      SettingsController.prototype,
      'updatePointsSettings',
    ) as unknown[];
    assert.notEqual(paramTypes[0], Object);
    assert.equal(paramTypes[0], UpdatePointsSettingsDto);
  });
});

describe('PATCH /admin/settings/points — what the pipe refuses', () => {
  it('refuses a percent above 100, below 0, or fractional, naming the field', async () => {
    await rejectsNaming({ cashback: { enabled: true, percent: 101 } }, 'percent');
    await rejectsNaming({ cashback: { enabled: true, percent: -1 } }, 'percent');
    await rejectsNaming({ cashback: { enabled: true, percent: 7.5 } }, 'percent');
  });

  it('refuses a switch that is not a boolean', async () => {
    await rejectsNaming({ cashback: { enabled: 'yes' } }, 'enabled');
    await rejectsNaming({ cashback: { enabled: null } }, 'enabled');
  });

  it('refuses keys nobody reads, at the root and inside cashback', async () => {
    await rejectsNaming({ cashback: { enabled: true }, exchange: {} }, 'exchange');
    await rejectsNaming({ cashback: { enabled: true, multiplier: 2 } }, 'multiplier');
  });

  it('lets an empty patch and a switch-only patch through', async () => {
    assert.deepEqual({ ...(await throughPipe({})) }, {});
    const switchOnly = await throughPipe({ cashback: { enabled: false } });
    assert.deepEqual({ ...switchOnly.cashback }, { enabled: false });
  });
});

describe('PATCH /admin/settings/points — what the route stores', () => {
  it('writes the switch and the percent and leaves an audit row naming the action', async () => {
    const db = makeSettingsDb({});

    const body = await throughPipe({ cashback: { enabled: true, percent: 5 } });
    const returned = await db.controller.updatePointsSettings(body, ADMIN, REQ);

    assert.equal(db.updates.length, 1);
    assert.deepEqual(db.updates[0]!.data.pointsSettings, { cashback: { enabled: true, percent: 5 } });
    assert.deepEqual(returned, { cashback: { enabled: true, percent: 5 } });
    assert.equal(db.auditLogs.length, 1);
    assert.equal(db.auditLogs[0]!['action'], 'settings.pointsSettings.update');
    const metadata = db.auditLogs[0]!['metadata'] as Record<string, unknown>;
    assert.deepEqual(metadata['patchKeys'], ['cashback']);
    assert.deepEqual(metadata['cashback'], { enabled: true, percent: 5 });
  });

  it('merges cashback one level deep: the switch alone does not lose the percent', async () => {
    const db = makeSettingsDb({ cashback: { enabled: true, percent: 5 } });

    const body = await throughPipe({ cashback: { enabled: false } });
    await db.controller.updatePointsSettings(body, ADMIN, REQ);

    assert.deepEqual(db.updates[0]!.data.pointsSettings, { cashback: { enabled: false, percent: 5 } });
  });

  it('GET answers with what is stored, and {} when nothing is', async () => {
    const stored = makeSettingsDb({ cashback: { enabled: true, percent: 7 } });
    assert.deepEqual(await stored.controller.getPointsSettings(), { cashback: { enabled: true, percent: 7 } });

    const empty = makeSettingsDb({});
    assert.deepEqual(await empty.controller.getPointsSettings(), {});
  });
});
