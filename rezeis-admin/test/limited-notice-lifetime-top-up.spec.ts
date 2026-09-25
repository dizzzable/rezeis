import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AddOnType } from '@prisma/client';

import { AddOnEligibilityService } from '../src/modules/add-ons/services/add-on-eligibility.service';
import { DEFAULT_NOTIFICATION_TEMPLATES } from '../src/modules/notifications/catalog/default-templates.catalog';
import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';

/**
 * «Трафик исчерпан» (`limited`) for a subscription with no end date (the owner,
 * 24.09.2026): such a subscription is never renewed, so its renewal button
 * becomes «📦 Докупить трафик» on the add-on page of that subscription, in the
 * bot and in the push — the address the cabinet's bell opens too
 * (reiwa `notification-target.ts`). The notice states the expiry in its payload
 * (`SubscriptionNoticePayloadService`), and `null` there is no end date.
 *
 * Through the real `UserNotificationsService` fan-out, with the operator's
 * template as the catalogue seeds it; the relay and the push are recording
 * doubles.
 */

type Relayed = { readonly buttons?: ReadonlyArray<{ readonly text: string; readonly webAppPath?: string; readonly callbackData?: string; readonly style?: string; readonly row?: number }> };

const SEEDED_LIMITED = DEFAULT_NOTIFICATION_TEMPLATES.find((template) => template.type === 'limited');

function relayingService(input: {
  readonly type: string;
  readonly buttons: unknown;
  readonly language?: string;
  /**
   * The add-on offer `create()` asks about (N1 gap 4), through the module
   * lookup the service uses: the types it lists, or an error. Absent: no
   * `AddOnsModule` at all.
   */
  readonly offer?: { readonly types: readonly AddOnType[] } | { readonly fails: string };
}) {
  const relayed: Relayed[] = [];
  const pushed: Array<{ readonly url: string }> = [];
  /** The payloads `create()` wrote, and the subscriptions the offer was asked about. */
  const written: unknown[] = [];
  const asked: string[] = [];
  const offer = input.offer;
  const moduleRef =
    offer === undefined
      ? undefined
      : {
          get: (token: unknown) => {
            if (token !== AddOnEligibilityService) throw new Error('unknown provider');
            return {
              listForSubscription: async (subscriptionId: string) => {
                asked.push(subscriptionId);
                if ('fails' in offer) throw new Error(offer.fails);
                return { addOns: offer.types.map((type) => ({ type })) };
              },
            };
          },
        };
  const prisma = {
    userNotificationEvent: {
      create: async (args: { data: { userId: string; type: string; payload: unknown } }) => {
        written.push(args.data.payload);
        return {
          id: 'evt-1',
          userId: args.data.userId,
          type: args.data.type,
          payload: args.data.payload,
        };
      },
      count: async () => 0,
      update: async () => ({}),
    },
    user: {
      findUnique: async () => ({
        telegramId: 42n,
        isBotBlocked: false,
        name: 'Вася',
        username: null,
        language: input.language ?? 'RU',
        notificationPrefs: null,
      }),
    },
    settings: { findUnique: async () => null },
  };
  const service = new UserNotificationsService(
    prisma as never,
    {
      getByType: async (type: string) => ({
        type,
        title: 'T',
        body: 'B',
        titleEn: null,
        bodyEn: null,
        isActive: true,
        bannerUrl: null,
        buttons: input.buttons,
      }),
    } as never,
    {} as never,
    {
      sendToUser: async (payload: { url: string }) => {
        pushed.push(payload);
        return { attempted: 1, delivered: 1, failed: 0, disabled: false };
      },
    } as never,
    { substituteTelegramHtml: async (text: string) => text, substituteFallbacks: async (text: string) => text } as never,
    {
      enqueue: async (_event: string, job: Relayed) => {
        relayed.push(job);
        return true;
      },
    } as never,
    undefined,
    undefined,
    undefined,
    moduleRef as never,
  );
  const send = async (payload: Record<string, unknown>) => {
    const notice = await service.createInTransaction(
      {
        userNotificationEvent: {
          create: async () => ({ id: 'evt-1', userId: 'u-1', type: input.type, payload }),
        },
      } as never,
      { userId: 'u-1', type: input.type, payload },
    );
    await notice.deliver();
  };
  /** Through `create()`, as the Remnawave webhook writes the notice; waits for its background fan-out. */
  const create = async (payload: Record<string, unknown>) => {
    await service.create({ userId: 'u-1', type: input.type, payload });
    for (let turn = 0; turn < 50 && pushed.length === 0; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { send, create, relayed, pushed, written, asked };
}

describe('«Трафик исчерпан» for a subscription with no end date', () => {
  it('fixture: the catalogue seeds `limited` with the renewal button and the main menu', () => {
    assert.deepEqual(
      SEEDED_LIMITED?.buttons?.map((button) => [button.kind, button.target]),
      [
        ['webApp', '/renew'],
        ['callback', 'menu:main'],
      ],
    );
  });

  it('turns the renewal button into «📦 Докупить трафик» on the add-on page of that subscription, and sends the push there', async () => {
    const { send, relayed, pushed } = relayingService({ type: 'limited', buttons: SEEDED_LIMITED?.buttons });

    await send({ subscriptionId: 'sub-1', expiresAt: null, daysLeft: 0 });

    assert.deepEqual(
      relayed[0]?.buttons?.map((button) => [button.text, button.webAppPath ?? button.callbackData]),
      [
        ['📦 Докупить трафик', '/addons?subscriptionId=sub-1'],
        ['🏠 Главное меню', 'menu:main'],
      ],
    );
    assert.equal(pushed[0]?.url, '/addons?subscriptionId=sub-1');
  });

  it('in the reader’s language, and for every button the operator pointed at renewal, keeping its colour and row', async () => {
    const { send, relayed } = relayingService({
      type: 'limited',
      language: 'EN',
      buttons: [
        { labelRu: 'Продлить', labelEn: 'Renew', kind: 'webApp', target: 'renew?from=bot', style: 'success', row: 0 },
        { labelRu: 'Устройства', labelEn: 'Devices', kind: 'webApp', target: '/subscription/devices', row: 0 },
      ],
    });

    await send({ subscriptionId: 'sub-1', expiresAt: null });

    assert.deepEqual(relayed[0]?.buttons, [
      { text: '📦 Buy more traffic', webAppPath: '/addons?subscriptionId=sub-1', style: 'success', row: 0 },
      { text: 'Devices', webAppPath: '/subscription/devices', row: 0 },
    ]);
  });

  it('control: a subscription with a date keeps the renewal, in the bot and in the push', async () => {
    const { send, relayed, pushed } = relayingService({ type: 'limited', buttons: SEEDED_LIMITED?.buttons });

    await send({ subscriptionId: 'sub-1', expiresAt: '2026-10-24T00:00:00.000Z' });

    assert.equal(relayed[0]?.buttons?.[0]?.text, '🔄 Продлить подписку');
    assert.equal(relayed[0]?.buttons?.[0]?.webAppPath, '/renew');
    assert.equal(pushed[0]?.url, '/renew');
  });

  it('control: a payload that states no expiry at all keeps the renewal — it says nothing about the date', async () => {
    const { send, relayed, pushed } = relayingService({ type: 'limited', buttons: SEEDED_LIMITED?.buttons });

    await send({ subscriptionId: 'sub-1' });

    assert.equal(relayed[0]?.buttons?.[0]?.webAppPath, '/renew');
    assert.equal(pushed[0]?.url, '/renew');
  });

  it('control: another notice with no expiry is left as the operator saved it', async () => {
    const { send, relayed, pushed } = relayingService({
      type: 'expired',
      buttons: [{ labelRu: '🔄 Продлить подписку', kind: 'webApp', target: '/renew' }],
    });

    await send({ subscriptionId: 'sub-1', expiresAt: null });

    assert.equal(relayed[0]?.buttons?.[0]?.webAppPath, '/renew');
    assert.equal(pushed[0]?.url, '/renew');
  });
});

/**
 * N1 gap 4 (25.09.2026): a lifetime subscription on a plan without a traffic
 * reset is sold no traffic add-on — "until the end" would be for ever — and
 * without «Сброс трафика» in the catalogue «📦 Докупить трафик» opened a page
 * with nothing on it. The button is there only when the subscription can buy
 * something that brings traffic back; the notice itself always goes.
 */
describe('«📦 Докупить трафик» only when there is something to buy', () => {
  it('nothing to buy: no «📦 Докупить трафик» and no renewal — the notice goes with its other buttons, the push opens the dashboard', async () => {
    const { send, relayed, pushed } = relayingService({ type: 'limited', buttons: SEEDED_LIMITED?.buttons });

    await send({ subscriptionId: 'sub-1', expiresAt: null, trafficTopUp: false });

    assert.deepEqual(
      relayed[0]?.buttons?.map((button) => [button.text, button.webAppPath ?? button.callbackData]),
      [['🏠 Главное меню', 'menu:main']],
    );
    assert.equal(pushed[0]?.url, '/dashboard');
  });

  it('something to buy: the button and the push go to the add-on page as before', async () => {
    const { send, relayed, pushed } = relayingService({ type: 'limited', buttons: SEEDED_LIMITED?.buttons });

    await send({ subscriptionId: 'sub-1', expiresAt: null, trafficTopUp: true });

    assert.deepEqual(
      relayed[0]?.buttons?.map((button) => [button.text, button.webAppPath ?? button.callbackData]),
      [
        ['📦 Докупить трафик', '/addons?subscriptionId=sub-1'],
        ['🏠 Главное меню', 'menu:main'],
      ],
    );
    assert.equal(pushed[0]?.url, '/addons?subscriptionId=sub-1');
  });

  it('the notice asks the add-on offer when it is written, and records the answer: only devices on offer — no button', async () => {
    const { create, relayed, pushed, written, asked } = relayingService({
      type: 'limited',
      buttons: SEEDED_LIMITED?.buttons,
      offer: { types: [AddOnType.EXTRA_DEVICES] },
    });

    await create({ subscriptionId: 'sub-1', expiresAt: null });

    assert.deepEqual(asked, ['sub-1']);
    assert.deepEqual(written, [{ subscriptionId: 'sub-1', expiresAt: null, trafficTopUp: false }]);
    assert.deepEqual(relayed[0]?.buttons?.map((button) => button.text), ['🏠 Главное меню']);
    assert.equal(pushed[0]?.url, '/dashboard');
  });

  it('a traffic add-on or «Сброс трафика» on offer brings the button', async () => {
    for (const type of [AddOnType.EXTRA_TRAFFIC, AddOnType.RESET_TRAFFIC]) {
      const { create, relayed, written } = relayingService({
        type: 'limited',
        buttons: SEEDED_LIMITED?.buttons,
        offer: { types: [AddOnType.EXTRA_DEVICES, type] },
      });

      await create({ subscriptionId: 'sub-1', expiresAt: null });

      assert.deepEqual(written, [{ subscriptionId: 'sub-1', expiresAt: null, trafficTopUp: true }], type);
      assert.equal(relayed[0]?.buttons?.[0]?.text, '📦 Докупить трафик', type);
    }
  });

  it('control: a dated subscription, and a notice that already answers, are not asked about; an offer that fails leaves the notice as before', async () => {
    const dated = relayingService({ type: 'limited', buttons: SEEDED_LIMITED?.buttons, offer: { types: [] } });
    await dated.create({ subscriptionId: 'sub-1', expiresAt: '2026-10-24T00:00:00.000Z' });
    assert.deepEqual(dated.asked, []);
    assert.deepEqual(dated.written, [{ subscriptionId: 'sub-1', expiresAt: '2026-10-24T00:00:00.000Z' }]);

    const answered = relayingService({ type: 'limited', buttons: SEEDED_LIMITED?.buttons, offer: { types: [] } });
    await answered.create({ subscriptionId: 'sub-1', expiresAt: null, trafficTopUp: true });
    assert.deepEqual(answered.asked, []);

    const failing = relayingService({ type: 'limited', buttons: SEEDED_LIMITED?.buttons, offer: { fails: 'database gone' } });
    await failing.create({ subscriptionId: 'sub-1', expiresAt: null });
    assert.deepEqual(failing.written, [{ subscriptionId: 'sub-1', expiresAt: null }], 'no answer is written');
    assert.equal(failing.relayed[0]?.buttons?.[0]?.text, '📦 Докупить трафик', 'and the notice keeps its button');
  });
});
