import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_NOTIFICATION_TEMPLATES } from '../src/modules/notifications/catalog/default-templates.catalog';
import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';

/**
 * «Вам начислено <b>50</b> за активного реферала»
 * ═══════════════════════════════════════════════
 * `referral_reward` prints `<b>{{amount}}</b> {{currency}}`, and a referral
 * reward is not money: it is points or days, per `rewardType`. The payment
 * pipeline sends no `currency` for it on purpose — the unit is a word in the
 * reader's language, known only when the message is rendered — so the renderer
 * supplies it.
 *
 * Rendered here through the fanout with the template the catalogue ships, and
 * read off the text handed to the Telegram relay: that is the sentence the
 * subscriber gets.
 */

const TEMPLATE = DEFAULT_NOTIFICATION_TEMPLATES.find((row) => row.type === 'referral_reward');

async function renderReward(
  language: 'RU' | 'EN',
  payload: Record<string, unknown>,
): Promise<string> {
  assert.ok(TEMPLATE, 'the catalogue no longer ships referral_reward');
  const texts: string[] = [];
  const prisma = {
    userNotificationEvent: {
      create: async (args: { data: { userId: string; type: string; payload: unknown } }) => ({
        id: 'evt-1',
        ...args.data,
      }),
      update: async () => ({}),
      count: async () => 0,
    },
    user: {
      findUnique: async () => ({
        telegramId: 4242n,
        isBotBlocked: false,
        name: 'Nina',
        username: null,
        language,
        notificationPrefs: null,
      }),
    },
    settings: { findUnique: async () => ({ userNotifications: {}, systemNotifications: {}, platformPolicy: null }) },
    webAccount: { findFirst: async () => null },
  };
  const service = new UserNotificationsService(
    prisma as never,
    {
      getByType: async (type: string) =>
        type === TEMPLATE.type
          ? {
              ...TEMPLATE,
              titleEn: TEMPLATE.titleEn ?? null,
              bodyEn: TEMPLATE.bodyEn ?? null,
              buttons: null,
              bannerUrl: null,
              isActive: true,
            }
          : null,
    } as never,
    {} as never,
    { sendToUser: async () => ({ attempted: 0, delivered: 0, failed: 0, disabled: true }) } as never,
    { substituteTelegramHtml: async (t: string) => t, substituteFallbacks: async (t: string) => t } as never,
    {
      enqueue: async (event: string, metadata: Record<string, unknown>) => {
        if (event === 'reiwa.user.notify') texts.push(String(metadata['text']));
        return true;
      },
    } as never,
  );

  await service.create({ userId: 'user-1', type: 'referral_reward', payload });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(texts.length, 1, 'the reward notification was not sent');
  return texts[0] as string;
}

const REWARD = { amount: 50, rewardId: 'r-1', referralId: 'ref-1', transactionId: 't-1' };

describe('the unit of a referral reward, in the reader’s language', () => {
  it('counts points in points', async () => {
    assert.ok(
      (await renderReward('RU', { ...REWARD, rewardType: 'POINTS' })).includes(
        'Вам начислено <b>50</b> баллов за активного реферала.',
      ),
    );
    assert.ok(
      (await renderReward('EN', { ...REWARD, rewardType: 'POINTS' })).includes(
        'You earned <b>50</b> points for an active referral.',
      ),
    );
  });

  it('counts extra days in days', async () => {
    assert.ok(
      (await renderReward('RU', { ...REWARD, amount: 7, rewardType: 'EXTRA_DAYS' })).includes(
        'Вам начислено <b>7</b> дн. за активного реферала.',
      ),
    );
    assert.ok(
      (await renderReward('EN', { ...REWARD, amount: 7, rewardType: 'EXTRA_DAYS' })).includes(
        'You earned <b>7</b> days for an active referral.',
      ),
    );
  });

  it('lets an emitter that names the unit keep its word', async () => {
    assert.ok(
      (await renderReward('RU', { ...REWARD, rewardType: 'POINTS', currency: 'RUB' })).includes(
        'Вам начислено <b>50</b> RUB за активного реферала.',
      ),
    );
  });

  it('invents nothing for a reward type it does not know', async () => {
    // Including a stored `rewardType` that happens to be an Object prototype
    // key — a lookup on a plain object would answer that with something.
    for (const rewardType of ['PROMO', 'constructor', '__proto__', 42]) {
      const text = await renderReward('RU', { ...REWARD, rewardType });
      assert.ok(text.includes('Вам начислено <b>50</b>  за активного реферала.'), `${String(rewardType)}: ${text}`);
    }
  });
});
