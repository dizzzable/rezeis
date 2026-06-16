import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { InternalUserEdgeService } from '../src/modules/internal-user/services/internal-user-edge.service';

/**
 * `updateLanguage` is fired by the reiwa locale-detect middleware for every
 * new user on their first message — often BEFORE `/start` bootstrap creates
 * the row (and for users gated out by REG_BLOCKED / RESTRICTED who never get
 * a row). A missing-row `prisma.user.update()` raises P2025; the service must
 * translate that into a clean 404, not a noisy unhandled 500.
 */
const STUB_SETTINGS_SERVICE = {
  getInternalPlatformPolicy: async () => ({ accessMode: 'PUBLIC' as const }),
};
const STUB_ACCESS_MODE_GUARD = { evaluate: () => null };

function buildService(userUpdate: () => Promise<unknown>): InternalUserEdgeService {
  const prisma = { user: { update: userUpdate } };
  return new InternalUserEdgeService(
    prisma as never,
    STUB_SETTINGS_SERVICE as never,
    STUB_ACCESS_MODE_GUARD as never,
  );
}

describe('InternalUserEdgeService.updateLanguage', () => {
  it('maps a missing-user P2025 to a 404 NotFoundException', async () => {
    const service = buildService(async () => {
      throw new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
        code: 'P2025',
        clientVersion: 'test',
      });
    });

    await assert.rejects(
      () => service.updateLanguage('123456789', 'RU'),
      (err: unknown) => err instanceof NotFoundException,
    );
  });

  it('rejects an unsupported language before touching the database', async () => {
    let called = false;
    const service = buildService(async () => {
      called = true;
      return {};
    });

    await assert.rejects(() => service.updateLanguage('123456789', 'zz'));
    assert.equal(called, false);
  });

  it('rethrows non-P2025 Prisma errors unchanged', async () => {
    const other = new Prisma.PrismaClientKnownRequestError('connection lost', {
      code: 'P1001',
      clientVersion: 'test',
    });
    const service = buildService(async () => {
      throw other;
    });

    await assert.rejects(
      () => service.updateLanguage('123456789', 'RU'),
      (err: unknown) => err === other,
    );
  });
});
