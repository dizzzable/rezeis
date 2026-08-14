import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger } from '@nestjs/common';

import { CustomEmojiPackInterface } from '../src/modules/custom-emoji/interfaces/custom-emoji-pack.interface';
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
  /** Counts settings writes: the service saves only when it saw a change. */
  readonly onWrite?: () => void;
}): CustomEmojiService {
  const row = { id: 'settings-1', systemNotifications: input.settings.systemNotifications };
  const settingsDelegate = {
    findFirst: async () => row,
    create: async () => row,
    update: async (args: { data: { systemNotifications: Record<string, unknown> } }) => {
      input.settings.systemNotifications = args.data.systemNotifications;
      row.systemNotifications = args.data.systemNotifications;
      input.onWrite?.();
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

  describe('re-import repairs the delivery fields of a pack already on record', () => {
    // `customEmojiId` and `fallback` are the only fields that ever reach
    // Telegram: without them the bot delivers the raw `:slug:` token. A pack
    // stored without them still has every file in place, so the repair cannot
    // sit behind the "some asset is missing" test — and re-importing the same
    // link is the only route an operator has that is not retyping ids one by
    // one.
    function settingsWithPack(
      emojis: ReadonlyArray<{
        readonly slug: string;
        readonly fallback: string | null;
        readonly customEmojiId: string | null;
      }>,
    ): StoredSettings {
      return {
        systemNotifications: {
          customEmojiPacks: [
            {
              id: 'existing-pack',
              name: 'News Emoji',
              setName: 'NewsEmoji',
              emojis: emojis.map((emoji) => ({
                slug: emoji.slug,
                name: emoji.slug,
                imageUrl: `/uploads/emoji/${emoji.slug}.webp`,
                lottieUrl: null,
                videoUrl: null,
                fallback: emoji.fallback,
                customEmojiId: emoji.customEmojiId,
              })),
            },
          ],
        },
      };
    }

    function storedEmojis(settings: StoredSettings): Array<Record<string, unknown>> {
      const packs = settings.systemNotifications.customEmojiPacks as
        | Array<{ emojis?: Array<Record<string, unknown>> }>
        | undefined;
      return packs?.[0]?.emojis ?? [];
    }

    function delivery(
      emoji: { readonly customEmojiId?: unknown; readonly fallback?: unknown } | undefined,
    ): readonly [unknown, unknown] {
      return [emoji?.customEmojiId, emoji?.fallback];
    }

    async function reimport(
      settings: StoredSettings,
      stickers: ReadonlyArray<Record<string, unknown>>,
      writes: { count: number },
    ): Promise<CustomEmojiPackInterface> {
      const service = makeService({
        settings,
        // Every file is present: this pack lost its ids, not its assets.
        assets: { exists: async () => true },
        onWrite: () => {
          writes.count += 1;
        },
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url: string | URL) => {
        assert.ok(String(url).includes('getStickerSet'), `unexpected Telegram call: ${String(url)}`);
        return telegramResponse({ ok: true, result: { title: 'News Emoji', stickers } });
      };
      try {
        return await service.importBySetLink({
          packName: 'News Emoji',
          link: 'https://t.me/addemoji/NewsEmoji',
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    it('fills in the ids and glyphs the pack was stored without, and saves them', async () => {
      const settings = settingsWithPack([
        { slug: 'news_1', fallback: null, customEmojiId: null },
        { slug: 'news_2', fallback: null, customEmojiId: null },
      ]);
      const writes = { count: 0 };

      const result = await reimport(
        settings,
        [
          { file_id: 'file-1', custom_emoji_id: '1001', emoji: '📰' },
          { file_id: 'file-2', custom_emoji_id: '1002', emoji: '🗞' },
        ],
        writes,
      );

      assert.equal(result.id, 'existing-pack');
      assert.deepStrictEqual(result.emojis.map(delivery), [
        ['1001', '📰'],
        ['1002', '🗞'],
      ]);
      // Without the ids nothing is downloaded and `setName` is already right,
      // so `changed` has to notice a repair that touched no file at all — else
      // the fix lives in the response only and the next read serves the old rows.
      assert.equal(writes.count, 1);
      assert.deepStrictEqual(storedEmojis(settings).map(delivery), [
        ['1001', '📰'],
        ['1002', '🗞'],
      ]);
    });

    it('never blanks a stored id with a sticker that carries none', async () => {
      const settings = settingsWithPack([
        { slug: 'news_1', fallback: null, customEmojiId: '1001' },
      ]);
      const writes = { count: 0 };

      // A plain sticker set (or a trimmed response) answers without
      // `custom_emoji_id`; following it blindly would delete a working id.
      const result = await reimport(settings, [{ file_id: 'file-1', emoji: '📰' }], writes);

      assert.deepStrictEqual(delivery(result.emojis[0]), ['1001', '📰']);
      assert.deepStrictEqual(delivery(storedEmojis(settings)[0]), ['1001', '📰']);
    });

    it('follows the source for a stale id while leaving a hand-picked glyph alone', async () => {
      const settings = settingsWithPack([
        // '9999' is no longer in the set (mistyped, or copied from elsewhere);
        // '📣' is a deliberate operator edit made through `updateEmoji`.
        { slug: 'news_1', fallback: '📣', customEmojiId: '9999' },
      ]);
      const writes = { count: 0 };

      const result = await reimport(
        settings,
        [{ file_id: 'file-1', custom_emoji_id: '1001', emoji: '📰' }],
        writes,
      );

      assert.deepStrictEqual(delivery(result.emojis[0]), ['1001', '📣']);
      assert.deepStrictEqual(delivery(storedEmojis(settings)[0]), ['1001', '📣']);
      assert.equal(writes.count, 1);
    });

    it('writes nothing when the set has nothing to add', async () => {
      const settings = settingsWithPack([
        { slug: 'news_1', fallback: '📰', customEmojiId: '1001' },
      ]);
      const writes = { count: 0 };
      const before = settings.systemNotifications.customEmojiPacks;

      await reimport(
        settings,
        [{ file_id: 'file-1', custom_emoji_id: '1001', emoji: '📰' }],
        writes,
      );

      // `changed` still has to mean something: a re-import of a healthy pack
      // must not rewrite settings on every call.
      assert.equal(writes.count, 0);
      assert.equal(settings.systemNotifications.customEmojiPacks, before);
    });

    // The set's author deleted a sticker, so every later sticker moved up one
    // position. A stored id that the set no longer contains does NOT make
    // position a second opinion about the same record — position now points at
    // the neighbour. Taking it stamped one record with its neighbour's id while
    // it kept its own picture and glyph: the panel showed one emoji, Telegram
    // delivered another, and the pack held the same id twice. Reachable without
    // an operator too — `custom-emoji-seed.service.ts` and `backup.processor.ts`
    // run the same pairing during a restore.
    it('does not hand a record its neighbour id when the set author deleted a sticker', async () => {
      const settings = settingsWithPack([
        { slug: 'news_1', fallback: '📰', customEmojiId: '1001' },
        { slug: 'news_2', fallback: '🗞', customEmojiId: '1002' },
        { slug: 'news_3', fallback: '📻', customEmojiId: '1003' },
      ]);
      const writes = { count: 0 };

      const result = await reimport(
        settings,
        [
          { file_id: 'file-2', custom_emoji_id: '1002', emoji: '🗞' },
          { file_id: 'file-3', custom_emoji_id: '1003', emoji: '📻' },
        ],
        writes,
      );

      const ids = result.emojis.map((emoji) => emoji.customEmojiId);
      assert.equal(
        new Set(ids).size,
        ids.length,
        `two records share a custom_emoji_id after re-import: ${ids.join(', ')}`,
      );
      assert.deepStrictEqual(ids, ['1001', '1002', '1003']);
      assert.deepStrictEqual(
        storedEmojis(settings).map((emoji) => emoji.customEmojiId),
        ['1001', '1002', '1003'],
      );
      // Nothing could be repaired, so nothing may be rewritten: a set that lost
      // a sticker upstream is not a reason to renumber a pack.
      assert.equal(writes.count, 0);
    });

    it('says so in the log instead of leaving a record unpaired in silence', async () => {
      const settings = settingsWithPack([
        { slug: 'news_1', fallback: '📰', customEmojiId: '1001' },
        { slug: 'news_2', fallback: '🗞', customEmojiId: '1002' },
      ]);
      const writes = { count: 0 };
      const warnings: string[] = [];
      const originalWarn = Logger.prototype.warn;
      Logger.prototype.warn = function capture(message: unknown): void {
        warnings.push(String(message));
      };
      try {
        await reimport(
          settings,
          [{ file_id: 'file-2', custom_emoji_id: '1002', emoji: '🗞' }],
          writes,
        );
      } finally {
        Logger.prototype.warn = originalWarn;
      }

      // Every file is present, so the existing "cannot recover" warning (which
      // sits behind the missing-asset test) never fires here. Declining the
      // pairing without a word would be the same silence the swap had.
      assert.ok(
        warnings.some((line) => line.includes('news_1')),
        `nothing was logged about the record that could not be paired; logged: ${JSON.stringify(warnings)}`,
      );
    });
  });

  // The panel and reiwa are handed the same two fields (`customEmojiId`,
  // `fallback`) and must resolve them identically, on every delivery path.
  // reiwa wraps a star when the entry has an id but no glyph of its own, so the
  // custom emoji arrives; the panel used to return an empty string for that
  // entry and delete the emoji from broadcasts and notifications while the very
  // same entry rendered fine through the bot.
  function packWithEmojis(
    emojis: ReadonlyArray<{
      readonly slug: string;
      readonly fallback: string | null;
      readonly customEmojiId: string | null;
    }>,
    botEmoji?: { readonly ownerHasPremium: boolean },
  ): StoredSettings {
    return {
      systemNotifications: {
        // The owner-premium switch is written into the SAME settings blob as
        // the packs (`bot-emoji-studio.service.ts:115`), which is why the
        // renderer can honour it without a second query or a fifth caller.
        ...(botEmoji === undefined ? {} : { botEmoji }),
        customEmojiPacks: [
          {
            id: 'pack-1',
            name: 'TG iOS/macOS Icons',
            emojis: emojis.map((emoji) => ({
              name: emoji.slug,
              imageUrl: '/uploads/emoji/icon.webp',
              lottieUrl: null,
              videoUrl: null,
              ...emoji,
            })),
          },
        ],
      },
    };
  }

  /** One entry per delivery state, shared by both renderers below. */
  const DELIVERY_STATES = [
    { slug: 'id_only', fallback: null, customEmojiId: '5188621441926438751' },
    // Blank is the same as absent — reiwa trims before it decides.
    { slug: 'blank_glyph', fallback: '   ', customEmojiId: '5188621441926438752' },
    // No numeric id survives stripping, so no tag: the star ships alone.
    { slug: 'broken_id', fallback: null, customEmojiId: 'not-an-id' },
    // Unchanged states, pinned in the same block so the rule stays whole.
    { slug: 'full', fallback: '📣', customEmojiId: '5188621441926438753' },
    { slug: 'glyph_only', fallback: '📣', customEmojiId: null },
    { slug: 'dead', fallback: null, customEmojiId: null },
  ] as const;

  describe('substituteTelegramHtml', () => {
    it('carries an id-only entry on a star instead of deleting it', async () => {
      const service = makeService({
        settings: packWithEmojis(DELIVERY_STATES),
        assets: { exists: async () => true },
      });

      assert.equal(
        await service.substituteTelegramHtml('Open :id_only: now'),
        'Open <tg-emoji emoji-id="5188621441926438751">⭐</tg-emoji> now',
      );
      assert.equal(
        await service.substituteTelegramHtml(':blank_glyph:'),
        '<tg-emoji emoji-id="5188621441926438752">⭐</tg-emoji>',
      );
      assert.equal(await service.substituteTelegramHtml(':broken_id:'), '⭐');

      assert.equal(
        await service.substituteTelegramHtml(':full:'),
        '<tg-emoji emoji-id="5188621441926438753">📣</tg-emoji>',
      );
      assert.equal(await service.substituteTelegramHtml(':glyph_only:'), '📣');
      assert.equal(await service.substituteTelegramHtml(':dead:'), '');
      // An unknown slug is the operator's own text and is left untouched.
      assert.equal(await service.substituteTelegramHtml(':nobody:'), ':nobody:');
    });

    // Telegram REJECTS a bot message that carries custom-emoji entities — and a
    // `<tg-emoji>` tag under `parse_mode: HTML` is exactly that — when the bot's
    // owner has no Telegram Premium. reiwa has always known this
    // (`emoji-utils.ts:260-264`); `renderBotCopy` strips the entities and
    // `renderBotCopyHtml` builds no tag at all (`:303`, `:314`). The panel sends
    // through the SAME bot token (`broadcast-delivery.service.ts:472,724,731`,
    // `user-notifications.service.ts:489-491`), so a tag the panel emits for a
    // non-premium owner can lose the whole broadcast, not just the artwork.
    //
    // The carrier still ships as plain text — reiwa's rule verbatim. The
    // operator loses the emoji, never the message.
    it('builds no <tg-emoji> for an owner without Premium, but still delivers the carrier', async () => {
      const service = makeService({
        settings: packWithEmojis(DELIVERY_STATES, { ownerHasPremium: false }),
        assets: { exists: async () => true },
      });

      assert.equal(await service.substituteTelegramHtml('Open :full: now'), 'Open 📣 now');
      // The id-only entry is the state today's carrier rule created: it used to
      // substitute nothing at all (no tag, so nothing Telegram could refuse),
      // and now produces a tag — "the emoji quietly vanished" turned into "the
      // message may not go out".
      assert.equal(await service.substituteTelegramHtml('Open :id_only: now'), 'Open ⭐ now');
      assert.equal(await service.substituteTelegramHtml(':blank_glyph:'), '⭐');

      // Unchanged states: none of these ever built a tag.
      assert.equal(await service.substituteTelegramHtml(':broken_id:'), '⭐');
      assert.equal(await service.substituteTelegramHtml(':glyph_only:'), '📣');
      assert.equal(await service.substituteTelegramHtml(':dead:'), '');
      assert.equal(await service.substituteTelegramHtml(':nobody:'), ':nobody:');

      // The plain-text path carries no entity and no tag in either case, so the
      // flag must not reach it — a non-premium owner still gets the same glyph.
      assert.equal(await service.substituteFallbacks('Open :full: now'), 'Open 📣 now');
      assert.equal(await service.substituteFallbacks(':id_only:'), '⭐');

      // The other half of the gate, asserted in the same test so it cannot be
      // satisfied by simply never emitting a tag. The flag defaults to true
      // when unset (the case the test above pins), so a deployment that never
      // touched the switch keeps its premium emoji; setting it explicitly must
      // not differ.
      const premium = makeService({
        settings: packWithEmojis(DELIVERY_STATES, { ownerHasPremium: true }),
        assets: { exists: async () => true },
      });
      assert.equal(
        await premium.substituteTelegramHtml(':full:'),
        '<tg-emoji emoji-id="5188621441926438753">📣</tg-emoji>',
      );
      assert.equal(
        await premium.substituteTelegramHtml(':id_only:'),
        '<tg-emoji emoji-id="5188621441926438751">⭐</tg-emoji>',
      );
    });
  });

  describe('substituteFallbacks', () => {
    // The plain-text path: media captions, non-HTML broadcast edits, and the
    // web-push title/body. Nothing here can carry a custom-emoji entity, so the
    // carrier is not a placeholder behind the artwork — it is the entire thing
    // the user sees. reiwa's own text renderer (`renderButtonLabel`,
    // emoji-utils.ts:391-397) substitutes '⭐' for an id-only entry for exactly
    // that reason; the panel used to send an empty string, so one pack entry
    // reached the user through the bot and through an HTML broadcast, and
    // silently disappeared from a photo caption and a browser push.
    it('carries an id-only entry on a star instead of deleting it', async () => {
      const service = makeService({
        settings: packWithEmojis(DELIVERY_STATES),
        assets: { exists: async () => true },
      });

      assert.equal(await service.substituteFallbacks('Open :id_only: now'), 'Open ⭐ now');
      // Blank is the same as absent — reiwa trims before it decides, and an
      // untrimmed '   ' used to reach Telegram as three spaces.
      assert.equal(await service.substituteFallbacks(':blank_glyph:'), '⭐');
      // A non-numeric id builds no tag anywhere, but it still says an emoji was
      // meant; there is no tag on this path in any case, so the star ships.
      assert.equal(await service.substituteFallbacks(':broken_id:'), '⭐');

      assert.equal(await service.substituteFallbacks(':full:'), '📣');
      assert.equal(await service.substituteFallbacks(':glyph_only:'), '📣');
      // Neither field set: nothing to send. Matches `substituteTelegramHtml`,
      // so the two panel renderers cannot disagree about the same entry.
      assert.equal(await service.substituteFallbacks(':dead:'), '');
      // An unknown slug is the operator's own text and is left untouched.
      assert.equal(await service.substituteFallbacks(':nobody:'), ':nobody:');
    });
  });

  describe('updateEmoji deliverability guard', () => {
    // Only `fallback` + `customEmojiId` ever leave the panel: the stored image
    // is a panel/cabinet asset. An entry holding neither field leaves the raw
    // shortcode in the message — the reported defect,
    // `:tg_ios_macos_icons_25: Перейти в канал` arriving verbatim — so the two
    // states that provably reach nobody are refused. An id without a glyph is
    // NOT one of them: both renderers carry it on a star.
    function packWithEmoji(
      overrides: Partial<{ fallback: string | null; customEmojiId: string | null }> = {},
    ): StoredSettings {
      return {
        systemNotifications: {
          customEmojiPacks: [
            {
              id: 'pack-1',
              name: 'TG iOS/macOS Icons',
              emojis: [
                {
                  slug: 'tg_ios_macos_icons_25',
                  name: 'TG iOS/macOS Icons 25',
                  imageUrl: '/uploads/emoji/icon-25.webp',
                  lottieUrl: null,
                  videoUrl: null,
                  fallback: '🙂',
                  customEmojiId: '5188621441926438751',
                  ...overrides,
                },
              ],
            },
          ],
        },
      };
    }

    function storedEmoji(settings: StoredSettings): Record<string, unknown> | undefined {
      const packs = settings.systemNotifications.customEmojiPacks as
        | Array<{ emojis?: Array<Record<string, unknown>> }>
        | undefined;
      return packs?.[0]?.emojis?.[0];
    }

    it('refuses a save that leaves neither a glyph nor a custom_emoji_id', async () => {
      const settings = packWithEmoji();
      const service = makeService({ settings, assets: { exists: async () => true } });

      await assert.rejects(
        () =>
          service.updateEmoji({
            packId: 'pack-1',
            slug: 'tg_ios_macos_icons_25',
            patch: { fallback: null, customEmojiId: null },
          }),
        /Set a fallback glyph or a custom_emoji_id/,
      );
      // The refusal must not have written a half-applied record.
      assert.equal(storedEmoji(settings)?.fallback, '🙂');
      assert.equal(storedEmoji(settings)?.customEmojiId, '5188621441926438751');
    });

    it('refuses a custom_emoji_id that is not the numeric Telegram id', async () => {
      const settings = packWithEmoji();
      const service = makeService({ settings, assets: { exists: async () => true } });

      await assert.rejects(
        () =>
          service.updateEmoji({
            packId: 'pack-1',
            slug: 'tg_ios_macos_icons_25',
            // Pasting the shortcode into the id field is the obvious mistake;
            // the renderer strips it to '' and sends the glyph without a word.
            patch: { customEmojiId: ':tg_ios_macos_icons_25:' },
          }),
        /digits only/,
      );
      assert.equal(storedEmoji(settings)?.customEmojiId, '5188621441926438751');
    });

    it('accepts a custom_emoji_id with no fallback glyph — the star carries it', async () => {
      const settings = packWithEmoji();
      const service = makeService({ settings, assets: { exists: async () => true } });

      await service.updateEmoji({
        packId: 'pack-1',
        slug: 'tg_ios_macos_icons_25',
        patch: { fallback: '   ', customEmojiId: '5188621441926438751' },
      });

      assert.equal(storedEmoji(settings)?.fallback, null);
      assert.equal(storedEmoji(settings)?.customEmojiId, '5188621441926438751');
      // Saved is not the point — it has to arrive. The guard was refusing a
      // state the bot delivers, so the renderer is asserted alongside it.
      assert.equal(
        await service.substituteTelegramHtml(':tg_ios_macos_icons_25:'),
        '<tg-emoji emoji-id="5188621441926438751">⭐</tg-emoji>',
      );
    });

    it('reports an unknown slug instead of answering 200 for an edit that never happened', async () => {
      const settings = packWithEmoji();
      const service = makeService({ settings, assets: { exists: async () => true } });

      await assert.rejects(
        () =>
          service.updateEmoji({
            packId: 'pack-1',
            slug: 'tg_ios_macos_icons_52',
            patch: { fallback: '🙃' },
          }),
        /Emoji not found/,
      );
    });

    it('still saves a deliverable edit, and a rename of a legacy dead record', async () => {
      const settings = packWithEmoji();
      const service = makeService({ settings, assets: { exists: async () => true } });

      await service.updateEmoji({
        packId: 'pack-1',
        slug: 'tg_ios_macos_icons_25',
        patch: { name: 'Channel', fallback: '📣', customEmojiId: '5188621441926438752' },
      });
      assert.equal(storedEmoji(settings)?.name, 'Channel');
      assert.equal(storedEmoji(settings)?.fallback, '📣');
      assert.equal(storedEmoji(settings)?.customEmojiId, '5188621441926438752');

      // A record imported dead stays editable: the guard only inspects a patch
      // that touches the delivery fields, so repairs and renames both work.
      const dead = packWithEmoji({ fallback: null, customEmojiId: null });
      const deadService = makeService({ settings: dead, assets: { exists: async () => true } });
      await deadService.updateEmoji({
        packId: 'pack-1',
        slug: 'tg_ios_macos_icons_25',
        patch: { name: 'Renamed' },
      });
      assert.equal(storedEmoji(dead)?.name, 'Renamed');

      await deadService.updateEmoji({
        packId: 'pack-1',
        slug: 'tg_ios_macos_icons_25',
        patch: { fallback: '📣' },
      });
      assert.equal(storedEmoji(dead)?.fallback, '📣');
    });
  });
});
