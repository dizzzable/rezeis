import 'reflect-metadata';

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { BroadcastMediaUploadService } from '../src/modules/broadcast/services/broadcast-media-upload.service';

/**
 * HIGH #19: a Telegram file_id is bound to the bot that uploaded it. The media
 * stash upload MUST use the same token-resolution priority as the delivery
 * worker (panel-managed encrypted token first, env BOT_TOKEN fallback) — else
 * every media broadcast fails with "wrong file identifier" whenever the two
 * tokens differ.
 */

interface FetchCall {
  url: string;
}

function buildService(opts: {
  storedToken: string | null;
  envToken: string | null;
  chatId?: string | null;
}): { service: BroadcastMediaUploadService; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const prisma = {
    settings: {
      findFirst: async () => ({
        systemNotifications: { telegram: { chatId: opts.chatId ?? '12345' } },
        paymentOpsAlerts: {},
      }),
    },
  };
  const settingsService = {
    getDecryptedBotToken: async () => opts.storedToken,
  };
  const service = new BroadcastMediaUploadService(
    prisma as never,
    { botToken: opts.envToken } as never,
    settingsService as never,
  );

  // Stub global fetch to capture the token embedded in the URL.
  (globalThis as { fetch: unknown }).fetch = async (url: string) => {
    calls.push({ url });
    return {
      json: async () => ({
        ok: true,
        result: { photo: [{ file_id: 'FILE_ID_LARGEST', file_size: 100 }] },
      }),
    };
  };

  return { service, calls };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('BroadcastMediaUploadService token resolution', () => {
  let originalFetch: unknown;
  beforeEach(() => {
    originalFetch = (globalThis as { fetch?: unknown }).fetch;
  });
  afterEach(() => {
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  });

  it('prefers the panel-managed token over env BOT_TOKEN', async () => {
    const { service, calls } = buildService({ storedToken: 'PANEL_TOKEN', envToken: 'ENV_TOKEN' });
    const res = await service.upload({
      buffer: PNG,
      originalName: 'a.png',
      mimeType: 'image/png',
      mediaType: 'photo',
    });
    assert.equal(res.fileId, 'FILE_ID_LARGEST');
    assert.ok(calls[0].url.includes('/botPANEL_TOKEN/'), `expected panel token in ${calls[0].url}`);
    assert.ok(!calls[0].url.includes('ENV_TOKEN'));
  });

  it('falls back to env BOT_TOKEN when no panel token is configured', async () => {
    const { service, calls } = buildService({ storedToken: null, envToken: 'ENV_TOKEN' });
    await service.upload({
      buffer: PNG,
      originalName: 'a.png',
      mimeType: 'image/png',
      mediaType: 'photo',
    });
    assert.ok(calls[0].url.includes('/botENV_TOKEN/'));
  });

  it('throws when neither token is configured', async () => {
    const { service } = buildService({ storedToken: null, envToken: null });
    await assert.rejects(
      () =>
        service.upload({
          buffer: PNG,
          originalName: 'a.png',
          mimeType: 'image/png',
          mediaType: 'photo',
        }),
      /BOT_TOKEN is not configured/,
    );
  });
});
