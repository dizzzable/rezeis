import 'reflect-metadata';

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { mergePaymentOpsAlertSettings } from '../src/common/utils/payment-ops-alert-settings.util';
import { BroadcastMediaUploadService } from '../src/modules/broadcast/services/broadcast-media-upload.service';

/**
 * The media stash needs SOME Telegram chat to upload into so the bot hands back
 * a `file_id`. Its documented second choice is the payment-ops chat.
 *
 * That fallback used to read `Settings.paymentOpsAlerts` - a Json column that
 * `prisma/schema.prisma` declares on `model Settings` with `@default("{}")`
 * and that NOTHING in the codebase writes.
 * `SettingsService.updatePaymentOpsAlertSettings`
 * persists the very same config into `systemNotifications.paymentOps` instead
 * (through `mergePaymentOpsAlertSettings`). So the fallback resolved to `{}` on
 * every request it ever served, and since there is no third choice behind it,
 * `upload()` threw 503 "Telegram stash chat is not configured" - telling an
 * operator who HAD configured the payment-ops chat to go configure a chat.
 *
 * The settings fixtures below are produced by the real write-path helper rather
 * than hand-shaped, so a spec that agrees with a wrong shape cannot pass.
 */

interface FetchCall {
  readonly url: string;
  readonly chatId: string | null;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function buildService(settingsRow: Record<string, unknown> | null): {
  service: BroadcastMediaUploadService;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const prisma = {
    settings: {
      findFirst: async (): Promise<Record<string, unknown> | null> => settingsRow,
    },
  };
  const settingsService = {
    getDecryptedBotToken: async (): Promise<string> => 'PANEL_TOKEN',
  };
  const service = new BroadcastMediaUploadService(
    prisma as never,
    { botToken: 'ENV_TOKEN' } as never,
    settingsService as never,
  );

  (globalThis as { fetch: unknown }).fetch = async (
    url: string,
    init: { body: FormData },
  ): Promise<unknown> => {
    const chatId = init.body.get('chat_id');
    calls.push({ url, chatId: typeof chatId === 'string' ? chatId : null });
    return {
      json: async (): Promise<unknown> => ({
        ok: true,
        result: { photo: [{ file_id: 'FILE_ID', file_size: 100 }] },
      }),
    };
  };

  return { service, calls };
}

function uploadPhoto(service: BroadcastMediaUploadService): Promise<unknown> {
  return service.upload({
    buffer: PNG,
    originalName: 'a.png',
    mimeType: 'image/png',
    mediaType: 'photo',
  });
}

/** Exactly what `SettingsService.updatePaymentOpsAlertSettings` persists. */
function systemNotificationsWithPaymentOpsChat(chatId: string): Record<string, unknown> {
  return mergePaymentOpsAlertSettings({
    systemNotifications: {},
    patch: { enabled: true, chatId },
  });
}

describe('BroadcastMediaUploadService stash chat resolution', () => {
  let originalFetch: unknown;

  beforeEach(() => {
    originalFetch = (globalThis as { fetch?: unknown }).fetch;
  });

  afterEach(() => {
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  });

  it('prefers systemNotifications.telegram.chatId over the payment-ops chat', async () => {
    const { service, calls } = buildService({
      systemNotifications: {
        ...systemNotificationsWithPaymentOpsChat('-1002222222222'),
        telegram: { chatId: '-1001111111111' },
      },
    });

    await uploadPhoto(service);

    assert.equal(calls[0]?.chatId, '-1001111111111');
  });

  it('falls back to the payment-ops chat as the settings service actually writes it', async () => {
    const systemNotifications = systemNotificationsWithPaymentOpsChat('-1002222222222');
    assert.deepEqual(
      Object.keys(systemNotifications),
      ['paymentOps'],
      'fixture guard: the write path must still nest under systemNotifications.paymentOps',
    );

    const { service, calls } = buildService({ systemNotifications });

    await uploadPhoto(service);

    assert.equal(calls[0]?.chatId, '-1002222222222');
  });

  it('does not consult the orphaned Settings.paymentOpsAlerts column', async () => {
    const { service, calls } = buildService({
      systemNotifications: {},
      // The shape the old fallback expected, in the column no writer ever fills.
      paymentOpsAlerts: { paymentOps: { enabled: true, chatId: '-1009999999999' } },
    });

    await assert.rejects(() => uploadPhoto(service), /Telegram stash chat is not configured/);
    assert.equal(calls.length, 0, 'nothing may be uploaded when no chat is configured');
  });

  it('reports the misconfiguration when neither chat is set', async () => {
    const { service } = buildService({ systemNotifications: {} });

    await assert.rejects(() => uploadPhoto(service), /Telegram stash chat is not configured/);
  });

  it('reports the misconfiguration when there is no settings row at all', async () => {
    const { service } = buildService(null);

    await assert.rejects(() => uploadPhoto(service), /Telegram stash chat is not configured/);
  });
});
