import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CustomEmojiSeedService } from '../src/modules/custom-emoji/services/custom-emoji-seed.service';
import { _resetProcessRoleCacheForTests } from '../src/common/runtime/process-role.util';

interface Recorder {
  readonly marked: string[];
  readonly builtinFlagged: string[];
  readonly backfilled: Array<{ id: string; setName: string }>;
  readonly recoveries: number[];
  readonly imported: Array<{ packName: string; link: string; builtin?: boolean }>;
}

function makeService(opts: {
  readonly seeded?: string[];
  readonly packs?: Array<{ id: string; name: string }>;
  readonly token?: string | null;
  readonly rec: Recorder;
}): CustomEmojiSeedService {
  const seeded = [...(opts.seeded ?? [])];
  const customEmojiService = {
    readSeededDefaults: async () => seeded,
    addSeededDefault: async (id: string) => {
      opts.rec.marked.push(id);
      seeded.push(id);
    },
    listPacks: async () => opts.packs ?? [],
    markPackBuiltin: async (id: string) => {
      opts.rec.builtinFlagged.push(id);
      return true;
    },
    backfillPackSource: async (id: string, input: { setName: string }) => {
      opts.rec.backfilled.push({ id, setName: input.setName });
      return true;
    },
    rehydrateMissingAssets: async () => {
      opts.rec.recoveries.push(1);
      return { recoveredEmojiCount: 0, skippedPacks: 0 };
    },
    importBySetLink: async (input: { packName: string; link: string; builtin?: boolean }) => {
      opts.rec.imported.push(input)
      return { id: `new-${input.link}`, name: input.packName, emojis: [] }
    },
  };
  const settingsService = {
    getDecryptedBotToken: async () => opts.token ?? null,
  };
  return new CustomEmojiSeedService(customEmojiService as never, settingsService as never);
}

describe('CustomEmojiSeedService', () => {
  it('flags an already-imported pack as builtin without re-downloading', async () => {
    const rec: Recorder = { marked: [], builtinFlagged: [], backfilled: [], recoveries: [], imported: [] };
    const service = makeService({
      packs: [{ id: 'pack-news', name: 'News Emoji' }],
      token: 'bot-token',
      rec,
    });

    await service.onApplicationBootstrap();

    assert.equal(rec.builtinFlagged.includes('pack-news'), true);
    assert.equal(rec.marked.includes('builtin_news'), true);
    // Existing pack must NOT be re-imported.
    assert.equal(rec.imported.some((i) => i.link === 'NewsEmoji'), false);
    assert.deepStrictEqual(rec.backfilled, [{ id: 'pack-news', setName: 'NewsEmoji' }]);
    assert.deepStrictEqual(rec.recoveries, [1]);
  });

  it('re-imports a missing builtin pack when a bot token is configured', async () => {
    const rec: Recorder = { marked: [], builtinFlagged: [], backfilled: [], recoveries: [], imported: [] };
    const service = makeService({ packs: [], token: 'bot-token', rec });

    await service.onApplicationBootstrap();

    const news = rec.imported.find((i) => i.link === 'NewsEmoji');
    assert.notEqual(news, undefined);
    assert.equal(news?.builtin, true);
    assert.equal(rec.marked.includes('builtin_news'), true);
  });

  it('skips import (and does not mark) when no bot token is configured', async () => {
    const rec: Recorder = { marked: [], builtinFlagged: [], backfilled: [], recoveries: [], imported: [] };
    const service = makeService({ packs: [], token: null, rec });

    await service.onApplicationBootstrap();

    assert.equal(rec.imported.length, 0);
    assert.equal(rec.marked.length, 0);
  });

  it('does not re-seed packs already in the marker', async () => {
    const rec: Recorder = { marked: [], builtinFlagged: [], backfilled: [], recoveries: [], imported: [] };
    const allIds = [
      'builtin_news', 'builtin_decoration', 'builtin_widestdicons', 'builtin_tgiosicons',
      'builtin_outline', 'builtin_translucent', 'builtin_tgmacicons', 'builtin_adaptivestatus',
      'builtin_restricted', 'builtin_application', 'builtin_game', 'builtin_islomjonanime',
    ];
    const service = makeService({ seeded: allIds, packs: [], token: 'bot-token', rec });

    await service.onApplicationBootstrap();

    assert.equal(rec.imported.length, 0);
    assert.equal(rec.builtinFlagged.length, 0);
    assert.equal(rec.marked.length, 0);
  });

  it('does not seed in the worker role', async () => {
    const rec: Recorder = { marked: [], builtinFlagged: [], backfilled: [], recoveries: [], imported: [] };
    const service = makeService({ packs: [{ id: 'pack-news', name: 'News Emoji' }], token: 'bot-token', rec });

    const prev = process.env.RUID_PROCESS_ROLE;
    process.env.RUID_PROCESS_ROLE = 'worker';
    _resetProcessRoleCacheForTests();
    try {
      await service.onApplicationBootstrap();
    } finally {
      if (prev === undefined) delete process.env.RUID_PROCESS_ROLE;
      else process.env.RUID_PROCESS_ROLE = prev;
      _resetProcessRoleCacheForTests();
    }

    assert.equal(rec.imported.length, 0);
    assert.equal(rec.builtinFlagged.length, 0);
    assert.equal(rec.marked.length, 0);
    assert.equal(rec.recoveries.length, 0);
  });
});
