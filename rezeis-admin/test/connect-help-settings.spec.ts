import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { AdminConnectHelpController } from '../src/modules/connect-help/controllers/admin-connect-help.controller';
import { ConnectHelpLogQueryDto } from '../src/modules/connect-help/dto/connect-help-log-query.dto';
import { UpdateConnectHelpSettingsDto } from '../src/modules/connect-help/dto/update-connect-help-settings.dto';
import { ConnectHelpSettingsService } from '../src/modules/connect-help/services/connect-help-settings.service';
import {
  decodeLogCursor,
  encodeLogCursor,
} from '../src/modules/connect-help/services/connect-help-status.service';
import {
  assertEffectiveRoutePermission,
  assertEveryRouteGuarded,
  assertRouteHandlers,
} from './helpers/controller-routes';

/**
 * «Помощь с подключением» — the operator's switches: what the API accepts,
 * where it writes, who may do either, and what it leaves behind in the audit.
 *
 * The global pipe is `whitelist + transform + forbidNonWhitelisted`
 * (`src/main.ts`), so the DTO cases run the real `ValidationPipe` with those
 * options rather than calling class-validator directly.
 */

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

async function accepts(body: unknown): Promise<UpdateConnectHelpSettingsDto> {
  return (await pipe.transform(body, {
    type: 'body',
    metatype: UpdateConnectHelpSettingsDto,
  })) as UpdateConnectHelpSettingsDto;
}

async function refuses(body: unknown, label: string): Promise<void> {
  await assert.rejects(
    () => pipe.transform(body, { type: 'body', metatype: UpdateConnectHelpSettingsDto }),
    BadRequestException,
    `${label} was accepted`,
  );
}

describe('PATCH /admin/connect-help/settings — what the body may say', () => {
  it('accepts the three switches, alone or together', async () => {
    assert.deepEqual({ ...(await accepts({ enabled: true })) }, { enabled: true });
    assert.deepEqual({ ...(await accepts({ delayHours: 1 })) }, { delayHours: 1 });
    assert.deepEqual({ ...(await accepts({ delayHours: 168 })) }, { delayHours: 168 });
    assert.deepEqual(
      { ...(await accepts({ enabled: false, delayHours: 37, includeTrials: true })) },
      { enabled: false, delayHours: 37, includeTrials: true },
    );
  });

  it('refuses hours outside 1–168, fractions and text — never clamps', async () => {
    for (const delayHours of [0, 169, -5, 1.5, '24', null]) {
      await refuses({ delayHours }, `delayHours ${JSON.stringify(delayHours)}`);
    }
  });

  it('refuses a switch that is not a boolean, null included', async () => {
    for (const value of ['true', 1, null]) {
      await refuses({ enabled: value }, `enabled ${JSON.stringify(value)}`);
      await refuses({ includeTrials: value }, `includeTrials ${JSON.stringify(value)}`);
    }
  });

  it('refuses a key it does not know', async () => {
    await refuses({ enabled: true, sendToEveryone: true }, 'an unknown key');
  });
});

describe('GET /admin/connect-help/log — the query', () => {
  const read = (query: unknown) =>
    pipe.transform(query, { type: 'query', metatype: ConnectHelpLogQueryDto }) as Promise<ConnectHelpLogQueryDto>;

  it('takes an outcome, `in_flight`, a cursor and a page size', async () => {
    const query = await read({ outcome: 'in_flight', cursor: 'abc', limit: '25' });
    assert.equal(query.outcome, 'in_flight');
    assert.equal(query.limit, 25);
    assert.equal((await read({ outcome: 'skipped_unverifiable' })).outcome, 'skipped_unverifiable');
  });

  it('refuses an outcome that does not exist and a page too large', async () => {
    await assert.rejects(() => read({ outcome: 'everything' }), BadRequestException);
    await assert.rejects(() => read({ limit: '101' }), BadRequestException);
  });

  it('pages with a cursor it issued, and refuses one it did not', () => {
    const at = new Date('2026-09-19T10:40:00.123Z');
    const cursor = encodeLogCursor(at, 'cmf0sub0000000000000001');
    assert.deepEqual(decodeLogCursor(cursor), { decidedAt: at, subscriptionId: 'cmf0sub0000000000000001' });
    for (const forged of [
      'not-base64-at-all!',
      Buffer.from('2026-13-45|x', 'utf8').toString('base64url'),
      Buffer.from("2026-09-19T10:40:00.123Z|x' OR 1=1 --", 'utf8').toString('base64url'),
      Buffer.from('|cmf0', 'utf8').toString('base64url'),
    ]) {
      assert.throws(() => decodeLogCursor(forged), BadRequestException, forged);
    }
  });
});

describe('who may read and who may change', () => {
  const proto = AdminConnectHelpController.prototype;

  it('exposes exactly the four routes, every one gated', () => {
    assertRouteHandlers(AdminConnectHelpController, ['getLog', 'getSettings', 'getStatus', 'updateSettings']);
    assertEveryRouteGuarded(AdminConnectHelpController);
  });

  it('reads with notifications:view, like the rest of the page', () => {
    for (const [label, handler] of [
      ['GET settings', proto.getSettings],
      ['GET status', proto.getStatus],
      ['GET log', proto.getLog],
    ] as const) {
      assertEffectiveRoutePermission(
        AdminConnectHelpController,
        handler,
        { resource: 'notifications', action: 'view' },
        label,
      );
    }
  });

  it('saves with settings:edit, like the page’s other switches', () => {
    assertEffectiveRoutePermission(
      AdminConnectHelpController,
      proto.updateSettings,
      { resource: 'settings', action: 'edit' },
      'PATCH settings',
    );
  });
});

/**
 * A transaction double that plays `mutateSettingsRow`'s part of the contract:
 * the lock statement first, the row read under it, the write, and whatever the
 * caller adds on the same transaction.
 */
function settingsHarness(stored: unknown) {
  const statements: string[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const reads: Array<Record<string, unknown>> = [];
  let transactions = 0;
  const tx = {
    $queryRaw: async (query: { sql: string }) => {
      statements.push(query.sql);
      return [{ id: 1 }];
    },
    settings: {
      findFirst: async () => {
        statements.push('read row');
        return { id: 1, connectHelpSettings: stored };
      },
      update: async (args: { where: { id: number }; data: Record<string, unknown> }) => {
        statements.push('write row');
        writes.push(args.data);
        return { id: 1, ...args.data };
      },
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        statements.push('audit');
        audits.push(args.data);
        return {};
      },
    },
  };
  const prisma = {
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => {
      transactions += 1;
      return work(tx);
    },
    settings: {
      findFirst: async (args: Record<string, unknown>) => {
        reads.push(args);
        return stored === undefined ? null : { connectHelpSettings: stored };
      },
    },
  };
  const service = new ConnectHelpSettingsService(prisma as never);
  return { service, statements, writes, audits, reads, transactions: () => transactions };
}

const ADMIN = { id: 'admin-1' } as never;
const REQUEST = { requestId: 'req-1', remoteAddress: '10.0.0.1', userAgent: 'spec' };

describe('reading the switches', () => {
  it('reads an install that never saved them as OFF / 24 h / OFF', async () => {
    for (const stored of [{}, undefined, null, [], 'garbage', { enabled: 'yes', delayHours: 500 }]) {
      const { service } = settingsHarness(stored);
      assert.deepEqual(await service.read(), { enabled: false, delayHours: 24, includeTrials: false }, JSON.stringify(stored));
    }
  });

  it('reads what was saved', async () => {
    const { service, reads } = settingsHarness({ enabled: true, delayHours: 6, includeTrials: true });
    assert.deepEqual(await service.read(), { enabled: true, delayHours: 6, includeTrials: true });
    assert.deepEqual(reads[0]['select'], { connectHelpSettings: true });
  });
});

describe('saving the switches', () => {
  it('writes under the row lock, merges onto what is stored, and audits in the same transaction', async () => {
    const { service, statements, writes, audits, transactions } = settingsHarness({
      enabled: false,
      delayHours: 12,
      futureKey: 'kept',
    });

    const saved = await service.update({ patch: { enabled: true }, currentAdmin: ADMIN, requestMetadata: REQUEST });

    assert.deepEqual(saved, { enabled: true, delayHours: 12, includeTrials: false });
    assert.equal(transactions(), 1);
    // The lock statement is the first thing the transaction runs.
    assert.match(statements[0], /FOR UPDATE/);
    assert.deepEqual(statements.slice(1), ['read row', 'write row', 'audit']);
    assert.deepEqual(writes, [{ connectHelpSettings: { enabled: true, delayHours: 12, futureKey: 'kept' } }]);
    assert.equal(audits.length, 1);
    const audit = audits[0];
    assert.equal(audit['action'], 'settings.connectHelp.updated');
    assert.deepEqual(audit['adminUser'], { connect: { id: 'admin-1' } });
    assert.equal(audit['ipAddress'], '10.0.0.1');
    assert.deepEqual(audit['metadata'], {
      requestId: 'req-1',
      patchKeys: ['enabled'],
      before: { enabled: false, delayHours: 12, includeTrials: false },
      after: { enabled: true, delayHours: 12, includeTrials: false },
    });
  });

  it('changes only what the patch names', async () => {
    const { service, writes } = settingsHarness({ enabled: true, delayHours: 48, includeTrials: true });
    await service.update({ patch: { delayHours: 72 }, currentAdmin: ADMIN, requestMetadata: REQUEST });
    assert.deepEqual(writes[0], { connectHelpSettings: { enabled: true, delayHours: 72, includeTrials: true } });
  });

  it('passes to the service only the fields the body carried', async () => {
    const calls: unknown[] = [];
    const controller = new AdminConnectHelpController(
      { update: async (input: unknown) => { calls.push(input); return {}; } } as never,
      {} as never,
    );
    await controller.updateSettings(
      (await accepts({ includeTrials: true })) as UpdateConnectHelpSettingsDto,
      ADMIN,
      { headers: {}, ip: '10.0.0.2', socket: {} } as never,
    );
    assert.deepEqual((calls[0] as { patch: unknown }).patch, { includeTrials: true });
  });
});
