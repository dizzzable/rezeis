import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InternalUserHintsController,
} from '../src/modules/user-hints/controllers/internal-user-hints.controller';

/**
 * THE HEADER HAS TO REACH THE QUERY.
 *
 * `hint-modes-header.spec.ts` beside this file pins `parseDrawableModes` as a
 * pure function, pins the `@Headers(...)` decorator's presence, and pins the
 * DTO staying clean. All three can be right while the controller drops the
 * parsed value on the floor — and they were: replacing
 * `modes: parseDrawableModes(modesHeader)` with `modes: null` left the whole
 * panel suite green.
 *
 * What that costs is the entire second mode. Every cabinet then resolves to
 * MODAL-only, so a TOAST an operator authored is queued, filtered out of every
 * ask, and never delivered — and the panel reports the rule as firing normally,
 * because it did fire. The hint simply never had a cabinet that would take it.
 *
 * Constructed directly rather than through Nest: the only collaborator that
 * matters here is the delivery service, and what is being checked is the ONE
 * argument the controller builds out of the header.
 */

interface RecordedAsk {
  readonly audience: { readonly modes: string[] | null };
}

function build(): {
  readonly controller: InternalUserHintsController;
  readonly asks: RecordedAsk[];
} {
  const asks: RecordedAsk[] = [];
  const deliveries = {
    nextFor: async (input: RecordedAsk) => {
      asks.push(input);
      return null;
    },
  };
  const prisma = {
    user: {
      findFirst: async () => ({ id: 'user-1' }),
      findUnique: async () => ({ id: 'user-1' }),
    },
  };

  const controller = new InternalUserHintsController(
    deliveries as never,
    prisma as never,
  );
  return { controller, asks };
}

/** The modes the controller actually asked the delivery service for. */
async function modesAskedFor(header: string | undefined): Promise<string[] | null> {
  const { controller, asks } = build();

  await controller.next({ telegramId: '123' } as never, header);

  assert.equal(asks.length, 1, 'the delivery service was not asked exactly once');
  return asks[0].audience.modes;
}

describe('the modes a cabinet declared', () => {
  it('reach the delivery service', async () => {
    assert.deepEqual(await modesAskedFor('MODAL,TOAST'), ['MODAL', 'TOAST']);
  });

  it('are still absent when the cabinet said nothing', async () => {
    // `null` is a distinct answer from `['MODAL']` all the way down: the
    // service resolves silence to what every cabinet draws, and it can only do
    // that if the doubt reaches it.
    assert.equal(await modesAskedFor(undefined), null);
  });

  it('carry a single declared mode through on its own', async () => {
    assert.deepEqual(await modesAskedFor('TOAST'), ['TOAST']);
  });
});
