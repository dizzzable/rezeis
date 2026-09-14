import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PaymentGatewayType } from '@prisma/client';
import { of, throwError } from 'rxjs';

import { PaymentOpsAlertService } from '../src/modules/payments/services/payment-ops-alert.service';

describe('PaymentOpsAlertService Telegram delivery', () => {
  it('sanitizes Telegram payment alert delivery failures', async () => {
    const warnings: string[] = [];
    const rawTelegramError = new Error(
      'payment alert failed bot-token chat 998877 https://api.telegram.org/botsecret/sendMessage provider payload secret',
    );
    Object.assign(rawTelegramError, { response: { status: 502 } });
    const service = new PaymentOpsAlertService(
      {
        settings: {
          findFirst: async () => ({
            systemNotifications: {
              paymentOps: {
                enabled: true,
                chatId: '998877',
                threadId: null,
                hashtag: '#payments_ops',
              },
            },
          }),
        },
      } as never,
      { post: () => throwError(() => rawTelegramError) } as never,
      { botToken: 'bot-token', adminPublicBaseUrl: null } as never,
    );
    (service as unknown as { readonly logger: { warn: (message: string) => void } }).logger.warn = (message: string): void => {
      warnings.push(message);
    };

    await service.notifyWebhookFailed({
      event: {
        id: 'event-1',
        paymentId: 'payment-1',
        providerEventId: 'provider-event-1',
        gatewayType: PaymentGatewayType.YOOKASSA,
        status: 'FAILED',
        lastError: 'raw payment processor traceback',
      } as never,
    });

    assert.deepStrictEqual(warnings, [
      'Unable to send payment ops alert to Telegram: TELEGRAM_DELIVERY_FAILED (status 502)',
    ]);
    const serialized = JSON.stringify(warnings);
    assert.equal(serialized.includes('bot-token'), false);
    assert.equal(serialized.includes('998877'), false);
    assert.equal(serialized.includes('api.telegram.org'), false);
    assert.equal(serialized.includes('provider payload secret'), false);
  });

  it('redacts raw webhook error diagnostics before sending payment ops alerts', async () => {
    const postedPayloads: Array<Record<string, unknown>> = [];
    const service = new PaymentOpsAlertService(
      {
        settings: {
          findFirst: async () => ({
            systemNotifications: {
              paymentOps: {
                enabled: true,
                chatId: '998877',
                threadId: null,
                hashtag: '#payments_ops',
              },
            },
          }),
        },
      } as never,
      {
        post: (_url: string, payload: Record<string, unknown>) => {
          postedPayloads.push(payload);
          return of({ data: { ok: true } });
        },
      } as never,
      { botToken: 'bot-token', adminPublicBaseUrl: null } as never,
    );

    await service.notifyWebhookFailed({
      event: {
        id: 'event-1',
        paymentId: 'payment-1',
        providerEventId: 'provider-event-1',
        gatewayType: PaymentGatewayType.YOOKASSA,
        status: 'FAILED',
        lastError:
          'provider said https://provider.example/profile/raw?token=secret admin@example.com 0194f4b6-7cc7-7ecb-9f62-123456789abc evt_supersecret123456 provider_abcdef123456 bearerTokenSecret abcdefabcdefabcdefabcdefabcdefabcd',
      } as never,
    });

    assert.equal(postedPayloads.length, 1);
    const text = String(postedPayloads[0]?.text ?? '');
    assert.equal(text.includes('kind:webhook_failed'), true);
    assert.equal(text.includes('error:'), true);
    assert.equal(text.includes('[url hidden]'), true);
    assert.equal(text.includes('[email hidden]'), true);
    assert.equal(text.includes('[uuid hidden]'), true);
    assert.equal(text.includes('[identifier hidden]'), true);
    assert.equal(text.includes('[secret hidden]'), true);
    assert.equal(text.includes('[token hidden]'), true);
    assert.equal(text.includes('provider.example'), false);
    assert.equal(text.includes('admin@example.com'), false);
    assert.equal(text.includes('0194f4b6-7cc7-7ecb-9f62-123456789abc'), false);
    assert.equal(text.includes('evt_supersecret123456'), false);
    assert.equal(text.includes('provider_abcdef123456'), false);
    assert.equal(text.includes('bearerTokenSecret'), false);
    assert.equal(text.includes('abcdefabcdefabcdefabcdefabcdefabcd'), false);
  });

  it('hides raw webhook identifiers and the admin host, and says where to look instead', async () => {
    const postedPayloads: Array<Record<string, unknown>> = [];
    const service = new PaymentOpsAlertService(
      {
        settings: {
          findFirst: async () => ({
            systemNotifications: {
              paymentOps: {
                enabled: true,
                chatId: '998877',
                threadId: null,
                hashtag: '#payments_ops',
              },
            },
          }),
        },
      } as never,
      {
        post: (_url: string, payload: Record<string, unknown>) => {
          postedPayloads.push(payload);
          return of({ data: { ok: true } });
        },
      } as never,
      { botToken: 'bot-token', domain: 'https://admin.example.internal' } as never,
    );

    await service.notifyWebhookReplay({
      event: {
        id: 'evt_rawpaymentalertsecret123456',
        paymentId: 'payment_rawpaymentalertsecret123456',
        providerEventId: 'provider_rawpaymentalertsecret123456',
        gatewayType: PaymentGatewayType.YOOKASSA,
        status: 'ENQUEUED',
        lastError: null,
      } as never,
      context: { force: true, reason: 'manual replay' },
    });

    assert.equal(postedPayloads.length, 1);
    const text = String(postedPayloads[0]?.text ?? '');
    assert.equal(text.includes('event_id:hidden'), true);
    assert.equal(text.includes('payment_id:present'), true);
    assert.equal(text.includes('provider_event_id:present'), true);
    assert.equal(text.includes('evt_rawpaymentalertsecret123456'), false);
    assert.equal(text.includes('payment_rawpaymentalertsecret123456'), false);
    assert.equal(text.includes('provider_rawpaymentalertsecret123456'), false);
    // No panel address of any shape: `1ae79ef9` took the admin host out of
    // these alerts, and a `link: https://<host>/payments#webhooks` line put it
    // back. The chat is not a place for it, and on the relay road Telegram
    // fetched the page to draw a link preview. Words say where to go instead.
    assert.equal(text.includes('admin.example.internal'), false);
    assert.equal(text.includes('/payments'), false);
    assert.equal(text.includes('link:'), false);
    assert.equal(text.includes('Подробности: панель → Платежи → Вебхуки'), true);
  });

  it('tags the alert with #payments_ops once when the operator kept the default tag', async () => {
    const { text } = await sendReplayAlert({ hashtag: '#payments_ops', domain: null });
    const lines = text.split('\n');
    assert.equal(
      lines.filter((line) => line === '#payments_ops').length,
      1,
      `the default tag is printed twice; got:\n${text}`,
    );
  });

  it('keeps both tags once each when the operator chose their own', async () => {
    const { text } = await sendReplayAlert({ hashtag: '#shop_money', domain: null });
    const lines = text.split('\n');
    assert.equal(lines.filter((line) => line === '#shop_money').length, 1);
    assert.equal(lines.filter((line) => line === '#payments_ops').length, 1);
  });

  it('never names the admin host, on the direct road or the relay road', async () => {
    // Every shape `REZEIS_DOMAIN` takes in the deployment guides, down both
    // doors out of rezeis. The relay door matters most: the cabinet's
    // `/notify-broadcast` sends with link previews on.
    for (const domain of ['https://admin.example.internal', 'admin.example.internal', 'admin.example.internal/']) {
      for (const road of ['direct', 'relay'] as const) {
        const { text } = await sendReplayAlert({ hashtag: null, domain, road });
        assert.ok(text.length > 0, `${road}/${domain}: nothing was sent`);
        assert.equal(text.includes('admin.example.internal'), false, `${road}/${domain}:\n${text}`);
        assert.equal(/https?:\/\//.test(text), false, `${road}/${domain}: a URL in\n${text}`);
        assert.equal(text.includes('Подробности: панель → Платежи → Вебхуки'), true, `${road}/${domain}`);
      }
    }
  });
});

async function sendReplayAlert(options: {
  readonly hashtag: string | null;
  readonly domain: string | null;
  /** `direct`: this host holds a token. `relay`: it does not, and the cabinet sends. */
  readonly road?: 'direct' | 'relay';
}): Promise<{ readonly text: string }> {
  const road = options.road ?? 'direct';
  const sent: string[] = [];
  const relayQueue = {
    isEnabled: true,
    enqueue: async (_event: string, metadata: Record<string, unknown>): Promise<boolean> => {
      sent.push(String(metadata.text ?? ''));
      return true;
    },
  };
  const service = new PaymentOpsAlertService(
    {
      settings: {
        findFirst: async () => ({
          systemNotifications: {
            paymentOps: {
              enabled: true,
              chatId: '998877',
              threadId: null,
              hashtag: options.hashtag,
            },
          },
        }),
      },
    } as never,
    {
      post: (_url: string, payload: Record<string, unknown>) => {
        sent.push(String(payload.text ?? ''));
        return of({ data: { ok: true } });
      },
    } as never,
    { botToken: road === 'direct' ? 'bot-token' : null, domain: options.domain } as never,
    { getDecryptedBotToken: async () => null } as never,
    { get: () => relayQueue } as never,
  );
  await service.notifyWebhookReplay({
    event: {
      id: 'evt-1',
      paymentId: 'payment-1',
      providerEventId: 'provider-1',
      gatewayType: PaymentGatewayType.YOOKASSA,
      status: 'ENQUEUED',
      lastError: null,
    } as never,
    context: { force: false, reason: 'manual replay' },
  });
  assert.equal(sent.length, 1, `${road}: expected one alert, got ${sent.length}`);
  return { text: sent[0] ?? '' };
}
