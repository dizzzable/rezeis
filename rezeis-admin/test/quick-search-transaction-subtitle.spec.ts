import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency, PaymentGatewayType, Prisma, TransactionStatus, UserRole } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { QuickSearchService } from '../src/modules/dashboard/services/quick-search.service';
import { RbacService } from '../src/modules/rbac/services/rbac.service';

/**
 * What a Cmd+K payment hit says under its label.
 *
 * Every status but COMPLETED used to read "pending payment" — a FAILED payment,
 * a CANCELED one and a REFUNDED one alike — and those hits hid the payment id,
 * the one thing that tells two unfinished attempts of the same amount apart.
 */

const PAYMENT_ID = 'cmfk2x9pq0011abcd1234efgh';

function serviceAnswering(status: TransactionStatus): QuickSearchService {
  const empty = { findMany: async (): Promise<never[]> => [] };
  const prisma = {
    user: empty,
    subscription: empty,
    promocode: empty,
    partner: empty,
    transaction: {
      findMany: async (args: Prisma.TransactionFindManyArgs) => {
        assert.ok(args.where, 'the payment search always narrows');
        return [
          {
            id: 'cmfk2x9pq0010abcd1234efgh',
            paymentId: PAYMENT_ID,
            status,
            gatewayType: PaymentGatewayType.YOOKASSA,
            amount: { toString: (): string => '299' },
            currency: Currency.RUB,
            gatewayId: null,
          },
        ];
      },
    },
  };
  const rbac = {
    hasPermission: async (_admin: unknown, resource: string, action: string): Promise<boolean> =>
      resource === 'payments' && action === 'view',
  } satisfies Pick<RbacService, 'hasPermission'>;
  // Both are classes with private members; the stand-ins answer only what the
  // service calls, with Prisma's own argument types.
  return new QuickSearchService(prisma as unknown as PrismaService, rbac as unknown as RbacService);
}

async function subtitleFor(status: TransactionStatus): Promise<string | undefined> {
  const hits = await serviceAnswering(status).search({
    rawQuery: 'cmfk2x9pq',
    currentAdmin: { id: 'admin-1', role: UserRole.ADMIN, rbacRoleId: 'role-1' },
  });
  assert.equal(hits.length, 1);
  return hits[0]?.subtitle;
}

describe('QuickSearchService payment hit subtitle', () => {
  for (const status of [
    TransactionStatus.FAILED,
    TransactionStatus.CANCELED,
    TransactionStatus.REFUNDED,
    TransactionStatus.PENDING,
    TransactionStatus.COMPLETED,
  ]) {
    it(`states ${status} and the payment id`, async () => {
      assert.equal(await subtitleFor(status), `${status} · ${PAYMENT_ID}`);
    });
  }
});
