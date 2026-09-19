import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException, HttpStatus, NotFoundException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalConnectHelpController } from '../src/modules/connect-signal/controllers/internal-connect-help.controller';
import { assertRoute, assertRouteHandlers } from './helpers/controller-routes';

/**
 * `POST /internal/user/:userRef/subscriptions/:subscriptionId/connect-help/dismiss`
 * — the contract the cabinet (`reiwa: admin-client subscription.dismissConnectHelp`)
 * is built against.
 *
 * The Prisma double answers `findFirst` by BOTH halves of its `where` — the
 * subscription id and the owner — so dropping the owner from the query makes a
 * foreign subscription dismissable here exactly as it would in production.
 */

const OWNER = 'cmowner00000000000000000001';
const STRANGER = 'cmstranger000000000000000001';

interface Sub {
  readonly id: string;
  readonly userId: string;
}

function harness(subscriptions: readonly Sub[]) {
  const writes: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
  const prisma = {
    user: {
      findUnique: async (args: { where: { id?: string; telegramId?: bigint } }) => {
        if (args.where.id === OWNER || args.where.id === STRANGER) return { id: args.where.id };
        if (args.where.telegramId === 858568447n) return { id: OWNER };
        return null;
      },
    },
    subscription: {
      // Filters by exactly the keys it is given: a query that dropped the owner
      // gets someone else's row back here, as it would from PostgreSQL.
      findFirst: async (args: { where: { id?: string; userId?: string } }) => {
        const found = subscriptions.find(
          (row) =>
            (args.where.id === undefined || row.id === args.where.id) &&
            (args.where.userId === undefined || row.userId === args.where.userId),
        );
        return found === undefined ? null : { id: found.id };
      },
    },
    $executeRaw: async (query: { sql: string; values: unknown[] }) => {
      writes.push({ sql: query.sql, values: query.values });
      return 1;
    },
  };
  return { controller: new InternalConnectHelpController(prisma as never), writes };
}

const MINE: Sub = { id: 'sub-mine', userId: OWNER };
const THEIRS: Sub = { id: 'sub-theirs', userId: STRANGER };

describe('the connect-help dismiss route', () => {
  it('is the guarded internal route the cabinet calls', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalConnectHelpController), 'internal/user');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, InternalConnectHelpController), [
      InternalAdminAuthGuard,
    ]);
    assertRouteHandlers(InternalConnectHelpController, ['dismissBanner']);
    assertRoute(
      InternalConnectHelpController.prototype.dismissBanner as never,
      { method: RequestMethod.POST, path: ':userRef/subscriptions/:subscriptionId/connect-help/dismiss' },
      'POST internal/user/:userRef/subscriptions/:subscriptionId/connect-help/dismiss',
    );
    assert.equal(
      Reflect.getMetadata(HTTP_CODE_METADATA, InternalConnectHelpController.prototype.dismissBanner),
      HttpStatus.OK,
    );
  });

  it('records the dismissal on the customer’s own subscription', async () => {
    const { controller, writes } = harness([MINE, THEIRS]);

    assert.deepStrictEqual(await controller.dismissBanner(OWNER, 'sub-mine'), { dismissed: true });

    assert.equal(writes.length, 1);
    assert.match(writes[0]!.sql, /"banner_dismissed_at" = COALESCE\("st"\."banner_dismissed_at"/);
    assert.ok(writes[0]!.values.includes('sub-mine'));
    assert.ok(!writes[0]!.values.includes('sub-theirs'));
  });

  it('resolves a Telegram id reference to the same customer', async () => {
    const { controller, writes } = harness([MINE]);

    assert.deepStrictEqual(await controller.dismissBanner('858568447', 'sub-mine'), { dismissed: true });
    assert.equal(writes.length, 1);
  });

  it('refuses someone else’s, an unknown subscription and an unknown customer alike — and writes nothing', async () => {
    const { controller, writes } = harness([MINE, THEIRS]);

    const refusals: string[] = [];
    for (const [userRef, subscriptionId] of [
      [OWNER, 'sub-theirs'],
      [OWNER, 'sub-nobody'],
      ['cmnobody000000000000000001', 'sub-mine'],
    ] as const) {
      await assert.rejects(controller.dismissBanner(userRef, subscriptionId), (error: unknown) => {
        assert.ok(error instanceof NotFoundException);
        refusals.push(JSON.stringify(error.getResponse()));
        return true;
      });
    }

    assert.equal(new Set(refusals).size, 1, 'the three refusals must be indistinguishable');
    assert.equal(writes.length, 0);
  });

  it('refuses a reference that is neither a reiwa id nor a Telegram id', async () => {
    const { controller, writes } = harness([MINE]);

    await assert.rejects(controller.dismissBanner('not a reference!', 'sub-mine'), BadRequestException);
    assert.equal(writes.length, 0);
  });
});
