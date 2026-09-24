import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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

function relayingService(input: { readonly type: string; readonly buttons: unknown; readonly language?: string }) {
  const relayed: Relayed[] = [];
  const pushed: Array<{ readonly url: string }> = [];
  const prisma = {
    userNotificationEvent: {
      create: async (args: { data: { userId: string; type: string; payload: unknown } }) => ({
        id: 'evt-1',
        userId: args.data.userId,
        type: args.data.type,
        payload: args.data.payload,
      }),
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
  return { send, relayed, pushed };
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
