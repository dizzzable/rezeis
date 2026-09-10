import 'reflect-metadata';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { PanelDevicesClient } from '../src/modules/remnawave/services/panel-devices.client';
import {
  USER_EXPORT_BUSY_MESSAGE,
  USER_EXPORT_MAX_CONCURRENT,
  UserExportService,
} from '../src/modules/users/services/user-export.service';
import { resolveExportColumns } from '../src/modules/users/utils/user-export.catalog';

/**
 * TWO OPERATORS PRESSING EXPORT, OR ONE OPERATOR PRESSING IT TWICE.
 *
 * Nothing about this export streams: `findMany` materialises every selected
 * user before a cell is written, `renderUserExportCsv` holds three full copies
 * of the file live at once, and `send` buffers the result again. One run of
 * that shape is ~300 MB at the 20 000-row ceiling; three concurrent runs were
 * measured at ≈900 MB against a container limited to 1024 MB.
 *
 * What sits at the top of that is not a slow export. It is the OOM killer
 * taking the API process — which logs nothing useful and drops EVERY OTHER
 * admin's session and every in-flight request in the panel. A refusal one
 * operator can read is the cheap half of that trade; the expensive half is
 * everyone else's afternoon.
 *
 * So the three things below are the whole contract: the second concurrent
 * export is refused, the refusal says something an operator can act on, and the
 * slot comes back — including after a run that threw, because a leaked slot
 * would refuse every export until the container is restarted, which is a worse
 * outage than the one being prevented.
 */

/** A promise a test resolves by hand, to hold an export open mid-flight. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

const COLUMNS = resolveExportColumns(['reiwa_id', 'username'], { allowElevated: true });

describe('two exports at once', () => {
  let service: UserExportService;
  /**
   * Holds the FIRST `findMany` open, and only the first.
   *
   * Only the first, deliberately. If the gate held every call, an export that
   * slipped past the guard would block on it instead of finishing — and the
   * case below would hang rather than fail, which is the same as not being able
   * to tell whether the guard is there at all.
   */
  let gate: { promise: Promise<void>; release: () => void } | null = null;
  /** Set by a test to make the query itself fail. */
  let failWith: Error | null = null;
  let findManyCalls = 0;

  beforeEach(async () => {
    gate = null;
    failWith = null;
    findManyCalls = 0;

    const testingModule = await Test.createTestingModule({
      providers: [
        UserExportService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findMany: async (): Promise<unknown[]> => {
                findManyCalls += 1;
                if (gate !== null && findManyCalls === 1) await gate.promise;
                if (failWith !== null) throw failWith;
                return [];
              },
            },
          },
        },
        {
          // Never reached: no column below has `source: 'panel'`. Provided
          // because Nest resolves constructor dependencies by position, and a
          // missing provider does not fail loudly — it shifts every later one.
          provide: PanelDevicesClient,
          useValue: {
            listAllDevices: async () => ({ kind: 'unreachable' as const }),
          },
        },
      ],
    }).compile();

    service = testingModule.get(UserExportService);
  });

  const run = (): Promise<unknown> =>
    service.exportCsv({ where: {}, columns: COLUMNS, limit: 100 });

  it('refuses the second one instead of letting the process run out of memory', async () => {
    // ANTI-VACUITY: a ceiling of zero would make every case here pass by
    // refusing everything, including the first export.
    assert.equal(USER_EXPORT_MAX_CONCURRENT, 1);

    const held = deferred();
    gate = held;
    const first = run();
    try {
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof ConflictException, 'the second export was not refused');
        assert.equal(error.getStatus(), 409);
        return true;
      });

      // The refusal has to be cheap: the second request must not have reached
      // the database at all, or it is holding a connection open while it waits
      // to be told no.
      assert.equal(findManyCalls, 1, 'the refused export queried anyway');
    } finally {
      // In a `finally` so a FAILING assertion above still lets the first export
      // finish. Otherwise the run that proves the guard is missing leaves a
      // promise pending for ever and the suite hangs instead of reporting.
      held.release();
      await first;
    }
  });

  it('tells the operator what happened and what to do about it', async () => {
    const held = deferred();
    gate = held;
    const first = run();
    try {
      await assert.rejects(run, (error: unknown) => {
        const message = (error as ConflictException).message;
        assert.equal(message, USER_EXPORT_BUSY_MESSAGE);
        // The same sentence has to be safe on a customer's screen: no address,
        // no port, no container name, no panel profile.
        assert.doesNotMatch(message, /\d+\.\d+\.\d+\.\d+|:\d{2,5}\b|localhost|rezeis|remnawave/i);
        return true;
      });
    } finally {
      held.release();
      await first;
    }
  });

  it('lets the next one through once the first has finished', async () => {
    const held = deferred();
    gate = held;
    const first = run();
    try {
      await assert.rejects(run);
    } finally {
      held.release();
      await first;
    }

    gate = null;
    await run();
    assert.equal(findManyCalls, 2, 'the slot never came back');
  });

  it('gives the slot back even when the export threw', async () => {
    // A leaked slot refuses every export for the lifetime of the process —
    // which is the outage this guard exists to prevent, arriving by a different
    // road. `finally`, not a decrement after the return.
    const held = deferred();
    gate = held;
    failWith = new Error('the database went away mid-export');
    const first = run();
    held.release();
    await assert.rejects(first, /the database went away mid-export/);

    gate = null;
    failWith = null;
    await run();
    assert.equal(findManyCalls, 2, 'a failed export kept its slot for ever');
  });
});
