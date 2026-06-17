import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BotEmojiStudioService } from '../src/modules/bot-config/services/bot-emoji-studio.service';
import {
  buildSlotUsage,
  scanPlaceholderKeys,
  CODE_SLOT_USAGE,
} from '../src/modules/bot-config/utils/slot-usage.util';

describe('slot-usage util', () => {
  it('scans distinct {{KEY}} placeholders', () => {
    assert.deepEqual(
      scanPlaceholderKeys('Hi {{CARD}} and {{TRIAL}} and {{CARD}} again').sort(),
      ['CARD', 'TRIAL'],
    );
    assert.deepEqual(scanPlaceholderKeys(''), []);
  });

  it('merges code-driven usage with a copy scan', () => {
    const usage = buildSlotUsage([{ label: 'text:welcome', text: 'Free: {{TRIAL}} {{CARD}}' }]);
    // Code map: TRIAL is used by the trial button.
    assert.ok(usage.TRIAL.includes('menu.trial-button'));
    // Scan: both TRIAL and CARD picked up the welcome text label.
    assert.ok(usage.TRIAL.includes('text:welcome'));
    assert.ok(usage.CARD.includes('text:welcome'));
    // Code-only slot still present without any text reference.
    assert.deepEqual(usage.SUB_PROFILE, [...CODE_SLOT_USAGE.SUB_PROFILE]);
  });
});

describe('BotEmojiStudioService.getStudio', () => {
  function build() {
    const prisma = {
      settings: {
        findFirst: async () => ({
          systemNotifications: {
            botEmoji: { ownerHasPremium: false },
            customEmojiPacks: [
              {
                id: 'p1',
                name: 'News',
                emojis: [
                  {
                    slug: 'fire',
                    name: 'Fire',
                    imageUrl: '/uploads/emoji/fire.png',
                    lottieUrl: null,
                    videoUrl: null,
                    fallback: '🔥',
                    customEmojiId: '111',
                  },
                ],
              },
            ],
          },
        }),
      },
    };
    const botEmojis = {
      listAll: async () => [
        { id: 'e1', key: 'TRIAL', unicode: '🆓', tgEmojiId: '111' },
        { id: 'e2', key: 'SUB_TRAFFIC', unicode: '📈', tgEmojiId: '999' },
        { id: 'e3', key: 'CARD', unicode: '💳', tgEmojiId: null },
      ],
    };
    const botTexts = {
      listAll: async () => [{ key: 'welcome', value: 'Hi {{CARD}} {{TRIAL}}', valueEn: '' }],
    };
    return new BotEmojiStudioService(prisma as never, botEmojis as never, botTexts as never);
  }

  it('joins a pack-backed premium id to a preview, and surfaces owner-premium', async () => {
    const view = await build().getStudio();
    assert.equal(view.ownerHasPremium, false);

    const trial = view.slots.find((s) => s.key === 'TRIAL');
    assert.ok(trial?.premiumPreview);
    assert.equal(trial?.premiumPreview?.slug, 'fire');
    assert.equal(trial?.premiumPreview?.packName, 'News');
    // Usage merges the code site + the welcome-text scan.
    assert.ok(trial?.usedIn.includes('menu.trial-button'));
    assert.ok(trial?.usedIn.includes('text:welcome'));
  });

  it('returns null preview for a non-pack id and for an unset premium', async () => {
    const view = await build().getStudio();
    const traffic = view.slots.find((s) => s.key === 'SUB_TRAFFIC');
    assert.equal(traffic?.tgEmojiId, '999');
    assert.equal(traffic?.premiumPreview, null); // id not in any pack
    assert.ok(traffic?.usedIn.includes('welcome.mini-profile'));

    const card = view.slots.find((s) => s.key === 'CARD');
    assert.equal(card?.tgEmojiId, null);
    assert.equal(card?.premiumPreview, null);
    assert.ok(card?.usedIn.includes('text:welcome'));
  });
});

describe('BotEmojiStudioService.setOwnerHasPremium', () => {
  function build() {
    const writes: Array<Record<string, unknown>> = [];
    let updated: Record<string, unknown> | null = null;
    const prisma = {
      settings: {
        findFirst: async () => ({
          id: 's1',
          systemNotifications: { customEmojiPacks: [], other: 'keep' },
        }),
        update: (args: { data: { systemNotifications: unknown } }) => {
          updated = args.data.systemNotifications as Record<string, unknown>;
          return args;
        },
      },
      adminAuditLog: {
        create: (args: Record<string, unknown>) => {
          writes.push(args);
          return args;
        },
      },
      $transaction: async (ops: unknown[]) => ops,
    };
    const service = new BotEmojiStudioService(
      prisma as never,
      { listAll: async () => [] } as never,
      { listAll: async () => [] } as never,
    );
    return { service, writes: () => writes, updated: () => updated };
  }

  it('merges the flag into botEmoji, preserves other settings, and audits', async () => {
    const ctx = build();
    const result = await ctx.service.setOwnerHasPremium({
      enabled: false,
      admin: { id: 'a1' } as never,
      requestMetadata: {
        remoteAddress: '1.2.3.4',
        userAgent: 'UA',
        requestId: 'req-1',
      } as never,
    });

    assert.equal(result, false);
    const next = ctx.updated() as { botEmoji: { ownerHasPremium: boolean }; other: string };
    assert.equal(next.botEmoji.ownerHasPremium, false);
    assert.equal(next.other, 'keep'); // untouched siblings survive the merge

    const audit = ctx.writes()[0] as { data: { action: string } };
    assert.equal(audit.data.action, 'bot_config.emoji.ownerPremium');
  });

  it('returns the requested value without writing when no settings row exists', async () => {
    const prisma = {
      settings: { findFirst: async () => null },
      adminAuditLog: { create: () => assert.fail('should not audit') },
      $transaction: async () => assert.fail('should not transact'),
    };
    const service = new BotEmojiStudioService(
      prisma as never,
      { listAll: async () => [] } as never,
      { listAll: async () => [] } as never,
    );
    const result = await service.setOwnerHasPremium({
      enabled: true,
      admin: { id: 'a1' } as never,
      requestMetadata: { remoteAddress: null, userAgent: null, requestId: 'r' } as never,
    });
    assert.equal(result, true);
  });
});
