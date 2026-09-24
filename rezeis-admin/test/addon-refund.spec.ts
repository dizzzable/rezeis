import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { Logger } from '@nestjs/common';
import { AddOnType } from '@prisma/client';

import {
  AddOnRefundService,
  describeAddOn,
  lowerByAddOn,
  predictedDevicesLine,
  readRefundedAddOnMarker,
} from '../src/modules/payments/services/addon-refund.service';

/**
 * «Возврат денег за докупку заканчивает её сразу» — the owner's decision of
 * 24.09.2026. The rules that need no database: how the card
 * names the add-on, how far a legacy column comes down, which payment is an
 * add-on at all, and what the card says of the extra devices. The doors and the
 * two kinds of add-on on PostgreSQL: `addon-refund-postgres.spec.ts`.
 */

afterEach(() => mock.restoreAll());

const PLAN = { deviceLimit: 3, trafficLimit: 100 };

describe('how the card names the add-on', () => {
  it('as the customer bought it', () => {
    assert.equal(describeAddOn(AddOnType.EXTRA_DEVICES, 1), '+1 устройство');
    assert.equal(describeAddOn(AddOnType.EXTRA_DEVICES, 2), '+2 устройства');
    assert.equal(describeAddOn(AddOnType.EXTRA_DEVICES, 5), '+5 устройств');
    assert.equal(describeAddOn(AddOnType.EXTRA_DEVICES, 12), '+12 устройств');
    assert.equal(describeAddOn(AddOnType.EXTRA_DEVICES, 22), '+22 устройства');
    assert.equal(describeAddOn(AddOnType.EXTRA_TRAFFIC, 50), '+50 ГБ');
    assert.equal(describeAddOn(AddOnType.RESET_TRAFFIC, 0), 'сброс трафика');
  });
});

describe('how far a legacy add-on takes the column down', () => {
  it('by its value', () => {
    assert.deepEqual(
      lowerByAddOn({ addOnType: AddOnType.EXTRA_DEVICES, addOnValue: 2 }, { deviceLimit: 5, trafficLimit: 100, planSnapshot: PLAN }),
      { kind: 'LOWER', from: 5, to: 3 },
    );
    assert.deepEqual(
      lowerByAddOn({ addOnType: AddOnType.EXTRA_TRAFFIC, addOnValue: 50 }, { deviceLimit: 3, trafficLimit: 150, planSnapshot: PLAN }),
      { kind: 'LOWER', from: 150, to: 100 },
    );
  });

  it('never below the plan’s value', () => {
    assert.deepEqual(
      lowerByAddOn({ addOnType: AddOnType.EXTRA_DEVICES, addOnValue: 2 }, { deviceLimit: 4, trafficLimit: 100, planSnapshot: PLAN }),
      { kind: 'LOWER', from: 4, to: 3 },
    );
    assert.deepEqual(
      lowerByAddOn({ addOnType: AddOnType.EXTRA_TRAFFIC, addOnValue: 50 }, { deviceLimit: 3, trafficLimit: 120, planSnapshot: PLAN }),
      { kind: 'LOWER', from: 120, to: 100 },
    );
  });

  it('and never up: an operator’s column below the plan stays where it is', () => {
    assert.deepEqual(
      lowerByAddOn({ addOnType: AddOnType.EXTRA_DEVICES, addOnValue: 2 }, { deviceLimit: 2, trafficLimit: 100, planSnapshot: PLAN }),
      { kind: 'LOWER', from: 2, to: 2 },
    );
  });

  it('nothing on an unlimited column, and nothing against a plan value it cannot read', () => {
    assert.deepEqual(
      lowerByAddOn({ addOnType: AddOnType.EXTRA_DEVICES, addOnValue: 2 }, { deviceLimit: 0, trafficLimit: 100, planSnapshot: PLAN }),
      { kind: 'UNLIMITED' },
    );
    assert.deepEqual(
      lowerByAddOn({ addOnType: AddOnType.EXTRA_TRAFFIC, addOnValue: 50 }, { deviceLimit: 3, trafficLimit: null, planSnapshot: PLAN }),
      { kind: 'UNLIMITED' },
    );
    assert.deepEqual(
      lowerByAddOn({ addOnType: AddOnType.EXTRA_DEVICES, addOnValue: 2 }, { deviceLimit: 5, trafficLimit: 100, planSnapshot: {} }),
      { kind: 'PLAN_UNKNOWN' },
    );
    assert.deepEqual(
      lowerByAddOn({ addOnType: AddOnType.EXTRA_TRAFFIC, addOnValue: 50 }, { deviceLimit: 3, trafficLimit: 150, planSnapshot: { trafficLimit: null } }),
      { kind: 'PLAN_UNKNOWN' },
    );
    // An unlimited plan (0 devices) gives no floor, and a broken value is no value.
    for (const deviceLimit of [0, 2.5, -1]) {
      assert.deepEqual(
        lowerByAddOn({ addOnType: AddOnType.EXTRA_DEVICES, addOnValue: 2 }, { deviceLimit: 5, trafficLimit: 100, planSnapshot: { deviceLimit } }),
        { kind: 'PLAN_UNKNOWN' },
        `a plan of ${deviceLimit} devices was read as a floor`,
      );
    }
  });
});

describe('which payment bought an add-on', () => {
  it('reads the add-on checkout’s marker', () => {
    assert.deepEqual(
      readRefundedAddOnMarker({
        snapshotSource: 'ADDON_PURCHASE',
        addOnType: 'EXTRA_TRAFFIC',
        addOnValue: 50,
        targetSubscriptionId: 'sub-1',
      }),
      { addOnType: AddOnType.EXTRA_TRAFFIC, addOnValue: 50, targetSubscriptionId: 'sub-1' },
    );
  });

  it('and nothing else', () => {
    assert.equal(readRefundedAddOnMarker({ id: 'plan-1', selectedDurationDays: 30 }), null);
    // Add-on fields on another kind of snapshot do not make it an add-on purchase.
    assert.equal(readRefundedAddOnMarker({ snapshotSource: 'RENEWAL', addOnType: 'EXTRA_DEVICES', addOnValue: 2 }), null);
    assert.equal(readRefundedAddOnMarker({ snapshotSource: 'ADDON_PURCHASE', addOnType: 'UNKNOWN', addOnValue: 1 }), null);
    assert.equal(readRefundedAddOnMarker({ snapshotSource: 'ADDON_PURCHASE', addOnType: 'EXTRA_DEVICES', addOnValue: 1.5 }), null);
    assert.equal(readRefundedAddOnMarker(null), null);
  });
});

describe('what the card says of the extra devices', () => {
  function service(input: {
    readonly planning: unknown;
    readonly execution?: unknown;
  }) {
    return new AddOnRefundService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        planForSubscription: async () => {
          if (input.planning instanceof Error) throw input.planning;
          return input.planning;
        },
      } as never,
      { executePlan: async () => input.execution } as never,
    );
  }
  const withCleanup = async <T>(on: boolean, run: () => Promise<T>): Promise<T> => {
    const saved = process.env.ADDON_DEVICE_CLEANUP_AUTO;
    process.env.ADDON_DEVICE_CLEANUP_AUTO = on ? 'true' : 'false';
    try {
      return await run();
    } finally {
      if (saved === undefined) delete process.env.ADDON_DEVICE_CLEANUP_AUTO;
      else process.env.ADDON_DEVICE_CLEANUP_AUTO = saved;
    }
  };

  it('how many the panel took off, with automatic cleanup on', async () => {
    const line = await withCleanup(true, () =>
      service({ planning: { status: 'PLANNED', planId: 'plan-1', targetCount: 2 }, execution: { status: 'APPLIED', deleted: 2 } }).reduceDevices('sub-1'),
    );
    assert.equal(line, 'Лишние устройства удалены: 2.');
  });

  it('nothing when there were none to take off', async () => {
    assert.equal(await service({ planning: { status: 'VERIFIED', projectionRevision: 3n } }).reduceDevices('sub-1'), null);
    assert.equal(
      await service({ planning: { status: 'NOT_APPLICABLE', reason: 'UNLIMITED_DEVICES', projectionRevision: 3n } }).reduceDevices('sub-1'),
      null,
    );
  });

  const APPROVE_PLAN =
    'Лишние устройства панель сама не удаляет: автоудаление выключено. Чтобы удалить их, утвердите план: ' +
    '«Доп. услуги» → вкладка «Доставка» → «Открыть инспектор подписки» → «ID подписки»: sub-1 → «Открыть» → ' +
    'впишите «Причина» → «Планы сокращения устройств» → «Утвердить» → «Утвердить и выполнить».';
  const REMOVED_AUTOMATICALLY =
    'Лишние устройства панель удалит сама, а если Remnawave не ответит — повторит, пока не удалит.';
  const RETRIED = 'Remnawave не ответила — лишние устройства панель удалит сама при следующей попытке, через 5 минут.';
  const BY_HAND =
    'Лишние устройства панель не удалила — удалите их вручную: «Пользователи» → клиент → вкладка «Подписки» → ' +
    '«Быстрые действия» → «Устройства (HWID)» → корзина у устройства → «Удалить».';

  it('what will happen, before the refund’s own run says what did: by stage 6', async () => {
    assert.equal(await withCleanup(true, async () => predictedDevicesLine('sub-1')), REMOVED_AUTOMATICALLY);
    assert.equal(await withCleanup(false, async () => predictedDevicesLine('sub-1')), APPROVE_PLAN);
  });

  it('where the plan waits, with automatic cleanup off', async () => {
    const line = await withCleanup(false, () =>
      service({ planning: { status: 'PLANNED', planId: 'plan-1', targetCount: 2 } }).reduceDevices('sub-1'),
    );
    assert.equal(line, APPROVE_PLAN);
  });

  it('a panel that did not answer: the queue tries again with cleanup on, the plan waits for the operator with it off', async () => {
    mock.method(Logger.prototype, 'warn', () => undefined);
    const planning = { status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' };
    assert.equal(await withCleanup(true, () => service({ planning }).reduceDevices('sub-1')), RETRIED);
    assert.equal(await withCleanup(false, () => service({ planning }).reduceDevices('sub-1')), APPROVE_PLAN);
    const planned = { status: 'PLANNED', planId: 'plan-1', targetCount: 2 };
    const execution = { status: 'DEFERRED', reason: 'PANEL_UNAVAILABLE' };
    assert.equal(await withCleanup(true, () => service({ planning: planned, execution }).reduceDevices('sub-1')), RETRIED);
  });

  it('where to remove them by hand when the reduction stopped for a person', async () => {
    mock.method(Logger.prototype, 'warn', () => undefined);
    assert.equal(await service({ planning: { status: 'BLOCKED', reason: 'X' } }).reduceDevices('sub-1'), BY_HAND);
    const planned = { status: 'PLANNED', planId: 'plan-1', targetCount: 2 };
    for (const execution of [{ status: 'BLOCKED', reason: 'X' }, { status: 'REMEDIATION_REQUIRED' }]) {
      assert.equal(await withCleanup(true, () => service({ planning: planned, execution }).reduceDevices('sub-1')), BY_HAND);
    }
  });

  it('a run that failed says what the queue will do', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    assert.equal(
      await withCleanup(true, () => service({ planning: new Error('down') }).reduceDevices('sub-1')),
      REMOVED_AUTOMATICALLY,
    );
  });
});

describe('a refund of a payment that bought no add-on', () => {
  it('ends nothing and says nothing', async () => {
    const service = new AddOnRefundService(
      { addOnEntitlement: { findMany: async () => [] } } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    assert.equal(
      await service.endForRefund({ id: 'tx-1', planSnapshot: { id: 'plan-1' } } as never, 'REFUND'),
      null,
    );
  });

  it('an add-on the panel could not reach is on the card, with where to lower the limit', async () => {
    mock.method(Logger.prototype, 'error', () => undefined);
    const service = new AddOnRefundService(
      {
        addOnEntitlement: {
          findMany: async () => {
            throw new Error('the database is not answering');
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const outcome = await service.endForRefund(
      {
        id: 'tx-1',
        planSnapshot: { snapshotSource: 'ADDON_PURCHASE', addOnType: 'EXTRA_DEVICES', addOnValue: 2, targetSubscriptionId: 'sub-1' },
      } as never,
      'REFUND',
    );
    assert.equal(outcome?.ended, false);
    assert.match(
      String(outcome?.note),
      /^Докупку «\+2 устройства» панель не отключила: уменьшите «Лимит устройств» вручную: «Пользователи» → клиент → вкладка «Подписки» → «Быстрые действия» → «Сохранить»\.$/,
    );
  });
});
