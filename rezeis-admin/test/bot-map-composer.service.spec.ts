import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as fc from 'fast-check';
import {
  BotButtonAction,
  BotButtonStyle,
  BotFlowButtonAction,
  BotFlowButtonStyle,
  BotFlowParseMode,
  BotFlowStatus,
} from '@prisma/client';

import { BotMapComposerService } from '../src/modules/bot-map/services/bot-map-composer.service';
import type { BotMapPayload } from '../src/modules/bot-map/interfaces/bot-map-payload.interface';

/**
 * Build a composer with stub services so we can test `compose()` directly.
 * `compose()` is pure; the constructor deps are not exercised here — they
 * back the live `build()` method only.
 */
function makeComposer(): BotMapComposerService {
  return new BotMapComposerService(
    null as never,
    null as never,
    null as never,
  );
}

const HELP_SCREEN = {
  id: 'screen-help',
  shortId: 'sc_help',
  flowId: 'flow-1',
  name: 'help',
  textRu: 'Поддержка',
  textEn: 'Support',
  parseMode: BotFlowParseMode.HTML,
  mediaType: null,
  mediaFileId: null,
  mediaUrl: null,
  positionX: 0,
  positionY: 0,
  isRoot: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  buttons: [
    {
      id: 'btn-help-renew',
      screenId: 'screen-help',
      labelRu: 'Продлить',
      labelEn: 'Renew',
      row: 0,
      col: 0,
      actionType: BotFlowButtonAction.WEBAPP,
      targetScreenId: null,
      url: null,
      webAppUrl: '/renew',
      callbackAction: null,
      style: BotFlowButtonStyle.PRIMARY,
      iconCustomEmojiId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'btn-help-back',
      screenId: 'screen-help',
      labelRu: 'Назад',
      labelEn: 'Back',
      row: 1,
      col: 0,
      actionType: BotFlowButtonAction.BACK,
      targetScreenId: null,
      url: null,
      webAppUrl: null,
      callbackAction: null,
      style: BotFlowButtonStyle.DEFAULT,
      iconCustomEmojiId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'btn-help-broken',
      screenId: 'screen-help',
      labelRu: 'Сломано',
      labelEn: 'Broken',
      row: 2,
      col: 0,
      actionType: BotFlowButtonAction.NAVIGATE,
      targetScreenId: 'sc_does_not_exist',
      url: null,
      webAppUrl: null,
      callbackAction: null,
      style: BotFlowButtonStyle.DEFAULT,
      iconCustomEmojiId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
} as never;

const PUBLISHED_FLOW = {
  id: 'flow-1',
  name: 'Main Flow',
  version: 1,
  status: BotFlowStatus.PUBLISHED,
  layoutData: null,
  publishedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  screens: [HELP_SCREEN],
} as never;

const REPLY_BUTTONS = [
  {
    id: 'reply-cabinet',
    buttonId: 'cabinet',
    label: 'Кабинет',
    style: BotButtonStyle.PRIMARY,
    iconCustomEmojiId: null,
    visible: true,
    onePerRow: true,
    orderIndex: 0,
    actionType: BotButtonAction.URL,
    actionTarget: 'https://localhost:5173',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'reply-help',
    buttonId: 'help',
    label: 'Помощь',
    style: BotButtonStyle.PRIMARY,
    iconCustomEmojiId: null,
    visible: true,
    onePerRow: true,
    orderIndex: 1,
    actionType: BotButtonAction.SCREEN,
    actionTarget: 'sc_help',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'reply-support',
    buttonId: 'support',
    label: 'Поддержка',
    style: BotButtonStyle.DEFAULT,
    iconCustomEmojiId: null,
    visible: true,
    onePerRow: false,
    orderIndex: 2,
    actionType: BotButtonAction.SUPPORT_URL,
    actionTarget: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
] as never;

const TEMPLATES = [
  {
    id: 'tpl-expires-3',
    type: 'expires_in_3_days',
    title: '⏳ Подписка истекает',
    body: 'Срок действия истекает',
    titleEn: '⏳ Expires soon',
    bodyEn: 'Subscription expires soon',
    isActive: true,
    buttons: [
      { labelRu: 'Продлить', labelEn: 'Renew', kind: 'webApp', target: '/renew' },
      { labelRu: 'Главное меню', labelEn: 'Main menu', kind: 'callback', target: 'menu:main' },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'tpl-promo',
    type: 'promocode.activated',
    title: '🏷 Промокод активирован',
    body: 'Промокод активирован',
    titleEn: null,
    bodyEn: null,
    isActive: true,
    buttons: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
] as never;

describe('BotMapComposerService.compose', () => {
  it('emits a node per surface + Mini App terminals only when referenced', () => {
    const composer = makeComposer();
    const out = composer.compose({
      flow: PUBLISHED_FLOW,
      replyButtons: REPLY_BUTTONS,
      templates: TEMPLATES,
    });

    const kinds = out.nodes.map((n) => n.kind);
    assert.ok(kinds.includes('graph-screen'), 'expected at least one graph-screen');
    assert.ok(kinds.includes('reply-keyboard'), 'expected the reply-keyboard pseudo-node');
    assert.equal(
      out.nodes.filter((n) => n.kind === 'notification').length,
      2,
      'one node per template',
    );
    // Both /renew (from expiry buttons + help screen webapp) and /promo
    // (default click-through for promocode.activated) are referenced.
    const terminalRoutes = out.nodes
      .filter((n) => n.kind === 'mini-app-terminal')
      .map((n) => (n as { route: string }).route)
      .sort();
    assert.deepStrictEqual(terminalRoutes, ['/promo', '/renew']);
    assert.equal(out.meta.flowStatus, 'PUBLISHED');
  });

  it('emits edges for every flow button — including URL/WEBAPP/BACK and broken NAVIGATE', () => {
    const composer = makeComposer();
    const out = composer.compose({
      flow: PUBLISHED_FLOW,
      replyButtons: [],
      templates: [],
    });
    const flowEdges = out.edges.filter((e) => e.id.startsWith('flow-btn:'));
    assert.equal(flowEdges.length, 3);
    const broken = flowEdges.find((e) => e.id === 'flow-btn:btn-help-broken');
    assert.ok(broken);
    assert.equal(broken.valid, false);
    assert.equal(broken.reason, 'unknown-shortid');
  });

  it('treats reply URL pointing at localhost as unsafe', () => {
    const composer = makeComposer();
    const out = composer.compose({
      flow: null,
      replyButtons: REPLY_BUTTONS,
      templates: [],
    });
    const cabinetEdge = out.edges.find((e) => e.id === 'reply-btn:reply-cabinet');
    assert.ok(cabinetEdge);
    assert.equal(cabinetEdge.valid, false);
    assert.equal(cabinetEdge.destination.kind, 'url');
  });

  it('emits one synthetic edge per stored notification button', () => {
    const composer = makeComposer();
    const out = composer.compose({
      flow: null,
      replyButtons: [],
      templates: TEMPLATES,
    });
    const expiryEdges = out.edges.filter((e) => e.source === 'notif:expires_in_3_days');
    assert.equal(expiryEdges.length, 2);
    assert.deepStrictEqual(
      expiryEdges.map((e) => e.destination.kind),
      ['webApp', 'mainMenu'],
    );
    // The promocode template has no buttons, so the composer emits a
    // virtual click-through edge to /promo.
    const promoDefault = out.edges.find((e) => e.id.startsWith('notif-default-'));
    assert.ok(promoDefault);
    assert.equal((promoDefault.destination as { route: string }).route, '/promo');
  });

  it('property — every edge.source is a real node id', () => {
    const composer = makeComposer();
    const samples = TEMPLATES as unknown as ReadonlyArray<unknown>;
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...samples), { minLength: 0, maxLength: samples.length }),
        (templates) => {
          const out = composer.compose({
            flow: PUBLISHED_FLOW,
            replyButtons: REPLY_BUTTONS,
            templates: templates as never,
          });
          const ids = new Set(out.nodes.map((n) => n.id));
          return out.edges.every((e) => ids.has(e.source));
        },
      ),
      { numRuns: 50 },
    );
  });

  it('property — every "valid" edge.target either exists as a node id OR is a mini-app-terminal node', () => {
    const composer = makeComposer();
    const samples = TEMPLATES as unknown as ReadonlyArray<unknown>;
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...samples), { minLength: 0, maxLength: samples.length }),
        (templates) => {
          const out: BotMapPayload = composer.compose({
            flow: PUBLISHED_FLOW,
            replyButtons: REPLY_BUTTONS,
            templates: templates as never,
          });
          const ids = new Set(out.nodes.map((n) => n.id));
          return out.edges
            .filter((e) => e.valid)
            .every((e) => {
              if (ids.has(e.target)) return true;
              return (
                e.target.startsWith('callback:') ||
                e.target === 'back' ||
                e.target === 'chat'
              );
            });
        },
      ),
      { numRuns: 50 },
    );
  });
});
