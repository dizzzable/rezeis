import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CustomEmojiService } from '../src/modules/custom-emoji/services/custom-emoji.service';

interface StoredSettings {
  systemNotifications: Record<string, unknown>;
}

function makeService(input: {
  readonly settings: StoredSettings;
  readonly assets: {
    readonly exists: (url: string | null | undefined) => Promise<boolean>;
    readonly persist?: (value: { buffer: Buffer; kind: string }) => Promise<{ url: string; size: number }>;
  };
}): CustomEmojiService {
  const row = { id: 'settings-1', systemNotifications: input.settings.systemNotifications };
  const settingsDelegate = {
    findFirst: async () => row,
    create: async () => row,
    update: async (args: { data: { systemNotifications: Record<string, unknown> } }) => {
      input.settings.systemNotifications = args.data.systemNotifications;
      row.systemNotifications = args.data.systemNotifications;
      return row;
    },
  };
  const prisma = {
    settings: settingsDelegate,
    $transaction: async <T>(callback: (tx: { settings: typeof settingsDelegate }) => Promise<T>) =>
      callback({ settings: settingsDelegate }),
  };
  return new CustomEmojiService(
    prisma as never,
    {
      exists: input.assets.exists,
      persist: input.assets.persist ?? (async () => ({ url: '/uploads/emoji/recovered.webp', size: 1 })),
    } as never,
    { getDecryptedBotToken: async () => 'bot-token' } as never,
  );
}

function telegramResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('CustomEmojiService', () => {
  it('reuses a legacy pack with matching emoji ids instead of creating a duplicate on re-import', async () => {
    const settings: StoredSettings = {
      systemNotifications: {
        customEmojiPacks: [
          {
            id: 'existing-pack',
            name: 'News Emoji',
            // Simulates records that lost setName in older normalizations.
            emojis: [
              {
                slug: 'news_1',
                name: 'News 1',
                imageUrl: '/uploads/emoji/still-here.webp',
                lottieUrl: null,
                videoUrl: null,
                fallback: '📰',
                customEmojiId: '1001',
              },
            ],
          },
        ],
      },
    };
    const service = makeService({ settings, assets: { exists: async () => true } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => telegramResponse({
      ok: true,
      result: { title: 'News Emoji', stickers: [{ file_id: 'file-1', custom_emoji_id: '1001' }] },
    });
    try {
      const result = await service.importBySetLink({
        packName: 'News Emoji',
        link: 'https://t.me/addemoji/NewsEmoji',
      });

      assert.equal(result.id, 'existing-pack');
      assert.equal(result.setName, 'NewsEmoji');
      const stored = (settings.systemNotifications.customEmojiPacks as Array<Record<string, unknown>>);
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.setName, 'NewsEmoji');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rehydrates a missing uploaded asset after a database-only restore', async () => {
    const settings: StoredSettings = {
      systemNotifications: {
        customEmojiPacks: [
          {
            id: 'restored-pack',
            name: 'News Emoji',
            setName: 'NewsEmoji',
            emojis: [
              {
                slug: 'news_1',
                name: 'News 1',
                imageUrl: '/uploads/emoji/missing.webp',
                lottieUrl: null,
                videoUrl: null,
                fallback: '📰',
                customEmojiId: '1001',
              },
            ],
          },
        ],
      },
    };
    const persisted: string[] = [];
    const service = makeService({
      settings,
      assets: {
        exists: async (url) => url !== '/uploads/emoji/missing.webp',
        persist: async () => {
          persisted.push('asset');
          return { url: '/uploads/emoji/recovered.webp', size: 4 };
        },
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL) => {
      const value = String(url);
      if (value.includes('getStickerSet')) {
        return telegramResponse({
          ok: true,
          result: { stickers: [{ file_id: 'file-1', custom_emoji_id: '1001' }] },
        });
      }
      if (value.includes('getFile')) {
        return telegramResponse({ ok: true, result: { file_path: 'emoji.webp' } });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    };
    try {
      const result = await service.rehydrateMissingAssets();

      assert.deepStrictEqual(result, { recoveredEmojiCount: 1, skippedPacks: 0 });
      assert.deepStrictEqual(persisted, ['asset']);
      const stored = (settings.systemNotifications.customEmojiPacks as Array<{ emojis: Array<{ imageUrl: string }> }>);
      assert.equal(stored[0]?.emojis[0]?.imageUrl, '/uploads/emoji/recovered.webp');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
