import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as fc from 'fast-check';
import {
  BotButtonAction,
  BotButtonStyle,
  BotFlowButtonAction,
  BotFlowButtonStyle,
  BotFlowMediaType,
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

  it('surfaces a PHOTO screen media as the graph-screen bannerUrl (and null otherwise)', () => {
    const composer = makeComposer();

    // Baseline: HELP_SCREEN has no media → bannerUrl null.
    const plain = composer.compose({
      flow: PUBLISHED_FLOW,
      replyButtons: REPLY_BUTTONS,
      templates: [],
    });
    const plainScreen = plain.nodes.find((n) => n.kind === 'graph-screen') as
      | { bannerUrl: string | null }
      | undefined;
    assert.equal(plainScreen?.bannerUrl, null);

    // PHOTO media → surfaced as bannerUrl; VIDEO media → NOT a banner (null).
    const photoFlow = {
      ...(PUBLISHED_FLOW as unknown as Record<string, unknown>),
      screens: [
        { ...(HELP_SCREEN as unknown as Record<string, unknown>), mediaType: BotFlowMediaType.PHOTO, mediaUrl: '/uploads/bot-flow/x.webp' },
        { ...(HELP_SCREEN as unknown as Record<string, unknown>), id: 'screen-vid', shortId: 'sc_vid', mediaType: BotFlowMediaType.VIDEO, mediaUrl: '/uploads/bot-flow/v.mp4' },
      ],
    } as never;
    const out = composer.compose({ flow: photoFlow, replyButtons: REPLY_BUTTONS, templates: [] });
    const screens = out.nodes.filter((n) => n.kind === 'graph-screen') as Array<{ id: string; bannerUrl: string | null }>;
    assert.equal(screens.find((s) => s.id === 'screen-help')?.bannerUrl, '/uploads/bot-flow/x.webp');
    assert.equal(screens.find((s) => s.id === 'screen-vid')?.bannerUrl, null);
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

  it('reads a notification button by its PATH, so a query string or fragment is not a broken route', () => {
    // «📲 Подключить» on the connect-help notice opens the dashboard told which
    // card to open. Compared whole, the string matched no known route and the
    // working button was drawn red on «Карта бота».
    const composer = makeComposer();
    const target = '/dashboard?connect=help&subscriptionId={subscriptionId}';
    const out = composer.compose({
      flow: null,
      replyButtons: [],
      templates: [
        {
          id: 'tpl-connect-help',
          type: 'connect_help',
          title: 'Не получилось подключиться?',
          body: 'Откройте экран подключения',
          titleEn: null,
          bodyEn: null,
          isActive: true,
          buttons: [
            { labelRu: '📲 Подключить', labelEn: '📲 Connect', kind: 'webApp', target },
            { labelRu: 'Продлить', labelEn: 'Renew', kind: 'webApp', target: '/renew#plans' },
            { labelRu: 'Опечатка', labelEn: 'Typo', kind: 'webApp', target: '/dashbord?connect=help' },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ] as never,
    });

    const edges = out.edges.filter((e) => e.source === 'notif:connect_help');
    assert.equal(edges.length, 3);
    const [connect, renew, typo] = edges;
    assert.equal(connect?.valid, true, 'the connect button was marked broken');
    assert.equal(connect?.target, 'mini-app:/dashboard');
    // The operator still reads the whole link it opens.
    assert.deepStrictEqual(connect?.destination, { kind: 'webApp', route: target });
    assert.equal(renew?.valid, true, 'a fragment made a known route broken');
    assert.equal(renew?.target, 'mini-app:/renew');
    // Only the query is forgiven, never the path: a misspelt route stays red.
    assert.equal(typo?.valid, false);
    const terminals = out.nodes.filter((n) => n.kind === 'mini-app-terminal').map((n) => n.id).sort();
    assert.deepStrictEqual(terminals, ['mini-app:/dashboard', 'mini-app:/renew']);
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

/**
 * Where a «Mini App» button goes, read the way the bot opens it, against the
 * pages the cabinet really has.
 *
 * A tester pointed a notification's button at «Покупка подписки» — `/subscribe`
 * on the map's list of Mini App pages — and the Mini App opened on its home
 * screen: the cabinet has no such page, and a path it does not have falls
 * through to the catch-all. The map drew that button green.
 */
describe('Mini App pages on «Карта бота»', () => {
  /**
   * The cabinet's pages a button can open, as reiwa routes them
   * (`web/src/App.tsx`). reiwa's `web/test/mini-app-screen-routes.test.tsx`
   * holds the same list and checks each against those routes. Change one,
   * change the other.
   */
  const CABINET_PAGES = [
    '/dashboard',
    '/open-in-browser',
    '/subscription',
    '/subscription/devices',
    '/subscription/connect',
    '/plans',
    '/renew',
    '/upgrade',
    '/addons',
    '/referrals',
    '/referrals/exchange',
    '/partner',
    '/promo',
    '/wheel',
    '/events',
    '/activity',
    '/settings',
    '/settings/transactions',
    '/settings/faq',
    '/support',
  ];

  const now = new Date();
  const replyButton = (overrides: Record<string, unknown>) => ({
    id: `reply-${String(overrides.buttonId)}`,
    label: String(overrides.buttonId),
    style: BotButtonStyle.PRIMARY,
    iconCustomEmojiId: null,
    visible: true,
    onePerRow: true,
    orderIndex: 0,
    actionTarget: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  const notification = (buttons: ReadonlyArray<{ target: string }>) => ({
    id: 'tpl-trial-ended',
    type: 'trial_ended',
    title: 'Пробный период закончился',
    body: 'Оформите подписку',
    titleEn: null,
    bodyEn: null,
    isActive: true,
    buttons: buttons.map((b, i) => ({ labelRu: `Кнопка ${i}`, labelEn: null, kind: 'webApp', target: b.target })),
    createdAt: now,
    updatedAt: now,
  });

  it('offers exactly the cabinet’s pages, and all of them, whether a button reaches them yet or not', () => {
    const out = makeComposer().compose({ flow: null, replyButtons: [], templates: [] });
    assert.deepStrictEqual(out.miniAppScreens.map((s) => s.route), CABINET_PAGES);
    for (const screen of out.miniAppScreens) {
      assert.ok(screen.nameRu.length > 0 && screen.nameEn.length > 0, screen.route);
    }
  });

  it('draws a button to `/subscribe` red — the cabinet has no such page — and one to «Тарифы» green', () => {
    const out = makeComposer().compose({
      flow: null,
      replyButtons: [],
      templates: [notification([{ target: '/subscribe' }, { target: '/plans' }])] as never,
    });
    const [subscribe, plans] = out.edges.filter((e) => e.source === 'notif:trial_ended');
    assert.equal(subscribe?.valid, false);
    assert.equal(subscribe?.reason, 'unknown-mini-app-route');
    assert.equal(plans?.valid, true);
    assert.equal(plans?.target, 'mini-app:/plans');
  });

  it('draws «Кабинет» with no address of its own to «Кабинет в браузере», where the bot sends it', () => {
    const out = makeComposer().compose({
      flow: null,
      replyButtons: [
        replyButton({ buttonId: 'cabinet', actionType: BotButtonAction.URL, actionTarget: null }),
        // An address the operator typed is theirs, and stays a link.
        replyButton({ buttonId: 'site', actionType: BotButtonAction.URL, actionTarget: 'https://example.com/' }),
      ] as never,
      templates: [],
    });
    const cabinet = out.edges.find((e) => e.id === 'reply-btn:reply-cabinet');
    assert.equal(cabinet?.valid, true);
    assert.equal(cabinet?.target, 'mini-app:/open-in-browser');
    assert.ok(out.nodes.some((n) => n.id === 'mini-app:/open-in-browser'));
    const site = out.edges.find((e) => e.id === 'reply-btn:reply-site');
    assert.deepStrictEqual(site?.destination, { kind: 'url', host: 'example.com', safe: true });
  });

  it('reads a path the way the bot opens it — without its leading slash, with a query — in every kind of button', () => {
    const screenButton = (id: string, webAppUrl: string) => ({
      ...(HELP_SCREEN as unknown as { buttons: Array<Record<string, unknown>> }).buttons[0],
      id,
      webAppUrl,
    });
    const flow = {
      ...(PUBLISHED_FLOW as unknown as Record<string, unknown>),
      screens: [
        {
          ...(HELP_SCREEN as unknown as Record<string, unknown>),
          buttons: [screenButton('btn-bare', 'renew'), screenButton('btn-query', '/promo?code=SALE'), screenButton('btn-typo', '/promoo')],
        },
      ],
    };
    const out = makeComposer().compose({
      flow: flow as never,
      replyButtons: [replyButton({ buttonId: 'buy', actionType: BotButtonAction.WEBAPP, actionTarget: 'plans' })] as never,
      templates: [notification([{ target: 'wheel' }])] as never,
    });
    const edge = (id: string) => out.edges.find((e) => e.id === id);
    assert.equal(edge('flow-btn:btn-bare')?.target, 'mini-app:/renew');
    assert.equal(edge('flow-btn:btn-query')?.target, 'mini-app:/promo');
    assert.deepStrictEqual(edge('flow-btn:btn-query')?.destination, { kind: 'webApp', route: '/promo?code=SALE' });
    assert.equal(edge('flow-btn:btn-typo')?.valid, false);
    assert.equal(edge('flow-btn:btn-typo')?.reason, 'unknown-mini-app-route');
    assert.equal(edge('reply-btn:reply-buy')?.target, 'mini-app:/plans');
    assert.equal(out.edges.find((e) => e.source === 'notif:trial_ended')?.target, 'mini-app:/wheel');
  });
});
