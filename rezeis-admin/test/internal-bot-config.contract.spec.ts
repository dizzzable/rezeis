import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BotButtonAction,
  BotButtonStyle,
  BotFlowButtonAction,
  BotFlowButtonStyle,
  BotFlowMediaType,
  BotFlowParseMode,
  BotFlowStatus,
} from '@prisma/client';

import { InternalBotConfigService } from '../src/modules/bot-config/services/internal-bot-config.service';

/**
 * Byte-parity guard for the `GET /api/internal/bot-config` contract (spec
 * Requirement 8). The bot-studio redesign (Waves 1–4) touched notification
 * templates, broadcasts and the read-only bot-map — NONE of which feed this
 * payload. This test pins the composed shape reiwa consumes so any accidental
 * drift in the contract fails loudly.
 *
 * We seed deterministic operator rows (one menu button, one emoji, one text +
 * its EN sibling, one published flow screen + button) and assert the mapped
 * payload exactly, plus the invariant entry shapes that reiwa depends on.
 */

const EXPECTED_TOP_LEVEL_KEYS = [
  'botEmojiOwnerHasPremium',
  'botEmojis',
  'buttons',
  'customEmojis',
  'features',
  'menuTextCustomEmojiIds',
  'screens',
  'screensVersion',
  'systemButtonIcons',
  'translations',
  'visual',
] as const;

function buildService() {
  const button = {
    buttonId: 'webapp',
    label: 'Открыть приложение',
    visible: true,
    orderIndex: 0,
    style: BotButtonStyle.PRIMARY,
    onePerRow: true,
    iconCustomEmojiId: '5276127848644503161',
    actionType: BotButtonAction.WEBAPP,
    actionTarget: null,
  };
  const emoji = { key: 'CUSTOM_SLOT', unicode: '✨', tgEmojiId: '111222333' };
  const texts = [
    { key: 'profile.subscription', value: 'Подписка', visible: true },
    { key: 'profile.subscription@en', value: 'Subscription', visible: true },
  ];
  const flow = {
    id: 'flow-1',
    version: 3,
    status: BotFlowStatus.PUBLISHED,
    screens: [
      {
        id: 'screen-1',
        shortId: 'root',
        name: 'Главное',
        textRu: 'Привет',
        textEn: 'Hi',
        parseMode: BotFlowParseMode.HTML,
        mediaType: BotFlowMediaType.PHOTO,
        mediaFileId: 'file-1',
        mediaUrl: null,
        isRoot: true,
        buttons: [
          {
            id: 'btn-1',
            labelRu: 'Дальше',
            labelEn: 'Next',
            row: 0,
            col: 0,
            actionType: BotFlowButtonAction.NAVIGATE,
            targetScreenId: 'next',
            url: null,
            webAppUrl: null,
            callbackAction: null,
            style: BotFlowButtonStyle.PRIMARY,
            iconCustomEmojiId: null,
          },
        ],
      },
    ],
  };

  const prismaService = {
    settings: { findFirst: () => Promise.resolve(null) },
    botButton: { count: async () => 1 },
    botEmoji: { findUnique: async () => ({ id: 'seeded' }) },
    botText: { findUnique: async () => ({ id: 'seeded' }) },
  };

  const service = new InternalBotConfigService(
    prismaService as never,
    { listAll: async () => [button] } as never,
    { listAll: async () => [emoji] } as never,
    { listAll: async () => texts } as never,
    { getActive: async () => flow } as never,
  );
  return { service, emoji };
}

describe('internal bot-config contract (byte-parity)', () => {
  it('exposes exactly the documented top-level keys', async () => {
    const { service } = buildService();
    const payload = await service.getConfig();
    assert.deepStrictEqual(Object.keys(payload).sort(), [...EXPECTED_TOP_LEVEL_KEYS]);
  });

  it('maps a menu button to the exact reiwa shape', async () => {
    const { service } = buildService();
    const payload = await service.getConfig();
    assert.deepStrictEqual(payload.buttons, [
      {
        id: 'webapp',
        emoji: '',
        label: 'Открыть приложение',
        visible: true,
        order: 0,
        style: 'primary',
        onePerRow: true,
        iconCustomEmojiId: '5276127848644503161',
        actionType: 'webapp',
        actionTarget: null,
      },
    ]);
  });

  it('maps a published flow screen + button to the exact reiwa shape', async () => {
    const { service } = buildService();
    const payload = await service.getConfig();
    assert.deepStrictEqual(payload.screens, [
      {
        id: 'screen-1',
        shortId: 'root',
        name: 'Главное',
        textRu: 'Привет',
        textEn: 'Hi',
        parseMode: 'html',
        mediaType: 'photo',
        mediaFileId: 'file-1',
        mediaUrl: null,
        isRoot: true,
        buttons: [
          {
            id: 'btn-1',
            labelRu: 'Дальше',
            labelEn: 'Next',
            row: 0,
            col: 0,
            action: 'navigate',
            targetShortId: 'next',
            url: null,
            webAppUrl: null,
            callbackAction: null,
            style: 'primary',
            iconCustomEmojiId: null,
          },
        ],
      },
    ]);
    assert.equal(payload.screensVersion, 'flow-1:3:PUBLISHED');
  });

  it('projects the @en text sibling into a `.en` translation key', async () => {
    const { service } = buildService();
    const payload = await service.getConfig();
    assert.equal(payload.translations['profile.subscription'], 'Подписка');
    assert.equal(payload.translations['profile.subscription.en'], 'Subscription');
  });

  it('keeps every botEmojis entry to the { unicode, tgEmojiId } shape', async () => {
    const { service, emoji } = buildService();
    const payload = await service.getConfig();
    for (const entry of Object.values(payload.botEmojis)) {
      assert.deepStrictEqual(Object.keys(entry).sort(), ['tgEmojiId', 'unicode']);
    }
    assert.deepStrictEqual(payload.botEmojis[emoji.key], {
      unicode: '✨',
      tgEmojiId: '111222333',
    });
    // menuTextCustomEmojiIds is the premium-id projection of botEmojis.
    assert.equal(payload.menuTextCustomEmojiIds[emoji.key], '111222333');
  });

  it('keeps visual + features + customEmojis defaults stable', async () => {
    const { service } = buildService();
    const payload = await service.getConfig();
    assert.equal(payload.botEmojiOwnerHasPremium, true);
    assert.deepStrictEqual(payload.customEmojis, {});
    assert.deepStrictEqual(Object.keys(payload.features).sort(), [
      'activityFeedEnabled',
      'miniAppEnabled',
      'partnersEnabled',
      'promoCodesEnabled',
      'referralsEnabled',
      'trialEnabled',
    ]);
    assert.equal(payload.visual.subscriptionInfoFormat, 'full');
    // Additive `bannerApplyAll` flag (W3b-4): default false when the
    // `bot.banner_apply_all` text row is absent.
    assert.equal(payload.visual.bannerApplyAll, false);
    // Additive `systemButtonIcons` map (PW4): empty when no
    // `bot.sysbtn_icon.*` rows are configured.
    assert.deepStrictEqual(payload.systemButtonIcons, {});
  });
});
