import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_NOTIFICATION_TEMPLATES } from '../src/modules/notifications/catalog/default-templates.catalog';
import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';
import { PartnerNotificationsService } from '../src/modules/partners/services/partner-notifications.service';

/**
 * «На баланс зачислено <b></b> .»
 * ═══════════════════════════════
 * Partner events are emitted under dot types, and the fanout renders them with
 * the CANONICAL template first: `partner.earning` → `partner_earning`,
 * `partner.withdrawal_approved` → `partner_withdrawal_completed`. Both print
 * `<b>{{amount}}</b> {{currency}}`, and the payload carried only
 * `amountMinor` — so a partner was told a sum had been credited, and not what
 * sum, in what.
 *
 * So these tests go through the whole road rather than the payload alone:
 * `PartnerNotificationsService` → `UserNotificationsService.create` → the
 * template lookup → the render → the text handed to the Telegram relay, with
 * the templates the catalogue actually ships. A payload that merely carried
 * the right keys under the wrong names would pass a payload test and fail
 * this one.
 */

interface Created {
  readonly userId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

function catalogueTemplate(type: string) {
  const row = DEFAULT_NOTIFICATION_TEMPLATES.find((template) => template.type === type);
  return row === undefined
    ? null
    : {
        type: row.type,
        title: row.title,
        body: row.body,
        titleEn: row.titleEn ?? null,
        bodyEn: row.bodyEn ?? null,
        buttons: null,
        bannerUrl: null,
        isActive: true,
      };
}

function build(opts: {
  readonly language?: 'RU' | 'EN';
  readonly currencyOverride?: string | null;
  readonly defaultCurrency?: string;
  readonly currencyReadFails?: boolean;
} = {}) {
  const created: Created[] = [];
  const telegramTexts: string[] = [];

  const prisma = {
    userNotificationEvent: {
      create: async (args: { data: Created }) => {
        created.push(args.data);
        return { id: `evt-${created.length}`, ...args.data };
      },
      update: async () => ({}),
      count: async () => 0,
    },
    user: {
      findUnique: async (args: { select: Record<string, boolean> }) => {
        if (args.select['partnerBalanceCurrencyOverride'] === true) {
          if (opts.currencyReadFails === true) throw new Error('database unavailable');
          return { partnerBalanceCurrencyOverride: opts.currencyOverride ?? null };
        }
        return {
          telegramId: 4242n,
          isBotBlocked: false,
          name: 'Nina',
          username: null,
          language: opts.language ?? 'RU',
          notificationPrefs: null,
        };
      },
    },
    settings: {
      findUnique: async () => ({
        defaultCurrency: opts.defaultCurrency ?? 'RUB',
        userNotifications: {},
        systemNotifications: {},
        platformPolicy: null,
      }),
    },
    webAccount: { findFirst: async () => null },
  };

  const notifications = new UserNotificationsService(
    prisma as never,
    { getByType: async (type: string) => catalogueTemplate(type) } as never,
    {} as never,
    { sendToUser: async () => ({ attempted: 0, delivered: 0, failed: 0, disabled: true }) } as never,
    {
      substituteTelegramHtml: async (text: string) => text,
      substituteFallbacks: async (text: string) => text,
    } as never,
    {
      enqueue: async (event: string, metadata: Record<string, unknown>) => {
        if (event === 'reiwa.user.notify') telegramTexts.push(String(metadata['text']));
        return true;
      },
    } as never,
  );
  const service = new PartnerNotificationsService(notifications, prisma as never);
  return { service, created, telegramTexts };
}

/** The fanout is fire-and-forget; let its awaits settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('a partner is told the sum, and what it is in', () => {
  it('prints the credited sum and the balance currency on an earning', async () => {
    const { service, telegramTexts } = build();

    await service.notifyEarning({ partnerUserId: 'p-1', amount: 15_050, level: 1, payerUserId: 'u-2' });
    await settle();

    assert.equal(telegramTexts.length, 1, 'the earning notification was not sent');
    assert.ok(
      telegramTexts[0]?.includes('На баланс зачислено <b>150.50</b> RUB. Уровень: 1.'),
      telegramTexts[0],
    );
  });

  it('prints the paid-out sum on an approved withdrawal', async () => {
    const { service, telegramTexts } = build();

    await service.notifyWithdrawalApproved({ partnerUserId: 'p-1', withdrawalId: 'w-1', amount: 150_000 });
    await settle();

    assert.ok(telegramTexts[0]?.includes('Вывод <b>1500</b> RUB зачислен.'), telegramTexts[0]);
  });

  it('says it in English to an English-speaking partner', async () => {
    const { service, telegramTexts } = build({ language: 'EN' });

    await service.notifyEarning({ partnerUserId: 'p-1', amount: 5, level: 2, payerUserId: 'u-2' });
    await settle();

    assert.ok(
      telegramTexts[0]?.includes('Your balance was credited with <b>0.05</b> RUB. Level: 2.'),
      telegramTexts[0],
    );
  });

  it('names the currency the balance is held in: the partner’s override before the default', async () => {
    const { service, created } = build({ currencyOverride: 'USDT', defaultCurrency: 'RUB' });

    await service.notifyEarning({ partnerUserId: 'p-1', amount: 1_000, level: 1, payerUserId: 'u-2' });

    assert.equal(created[0]?.payload['currency'], 'USDT');
    assert.equal(created[0]?.payload['amount'], '10');
  });

  it('keeps amountMinor, which the dot-type templates and operators’ own copy print', async () => {
    const { service, created } = build();

    await service.notifyWithdrawalRejected({
      partnerUserId: 'p-1',
      withdrawalId: 'w-1',
      amount: 99,
      reason: 'wrong requisites',
    });

    assert.deepStrictEqual(created[0]?.payload, {
      withdrawalId: 'w-1',
      amountMinor: 99,
      amount: '0.99',
      currency: 'RUB',
      reason: 'wrong requisites',
    });
  });

  it('still notifies when the currency cannot be read, with the sum and without the unit', async () => {
    const { service, created } = build({ currencyReadFails: true });

    await service.notifyEarning({ partnerUserId: 'p-1', amount: 12_345, level: 1, payerUserId: 'u-2' });

    assert.equal(created.length, 1, 'a failed currency read must not cost the notification');
    assert.equal(created[0]?.payload['amount'], '123.45');
    assert.equal('currency' in (created[0]?.payload ?? {}), false);
  });
});
