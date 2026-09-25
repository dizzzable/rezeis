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
import { LOCAL_ADDRESS_TABLE } from './bot-map-local-address-table';

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

  // The owner, 24.09.2026: «Трафик исчерпан» for a subscription with no end
  // date sends its renewal buttons to the add-on page instead
  // (`offerTrafficTopUpForLifetime`). The map shows that beside the button,
  // or beside the default click-through when the template has none.
  it('draws where «Трафик исчерпан» sends a subscription with no end date: «📦 Докупить трафик» to the add-on page', () => {
    const composer = makeComposer();
    const limited = (buttons: unknown[]) =>
      ({
        id: 'tpl-limited',
        type: 'limited',
        title: '⚠️ Подписка ограничена',
        body: 'Лимит трафика исчерпан',
        titleEn: null,
        bodyEn: null,
        isActive: true,
        buttons,
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as never;
    const out = composer.compose({
      flow: null,
      replyButtons: [],
      templates: [
        limited([
          { labelRu: '🔄 Продлить подписку', labelEn: '🔄 Renew subscription', kind: 'webApp', target: '/renew' },
          { labelRu: '🏠 Главное меню', labelEn: '🏠 Main menu', kind: 'callback', target: 'menu:main' },
        ]),
        ...(TEMPLATES as unknown as unknown[]),
      ] as never,
    });

    const edges = out.edges.filter((e) => e.source === 'notif:limited');
    assert.deepStrictEqual(
      edges.map((e) => e.id),
      ['notif-btn:notif:limited:0', 'notif-btn:notif:limited:1', 'notif-lifetime:notif:limited:0'],
      'the template’s two buttons, and the lifetime case beside the renewal one',
    );
    assert.equal(edges[0]?.target, 'mini-app:/renew', 'a subscription with a date still renews');
    const lifetime = edges.find((e) => e.id === 'notif-lifetime:notif:limited:0');
    assert.equal(lifetime?.target, 'mini-app:/addons');
    assert.equal(lifetime?.valid, true);
    assert.deepStrictEqual(lifetime?.destination, { kind: 'webApp', route: '/addons' });
    // Only when there is something to buy (N1 gap 4): the label says so.
    assert.match(
      lifetime?.sourceLabel ?? '',
      /^📦 Докупить трафик — у бессрочной подписки, если ей есть что докупить, вместо «🔄 Продлить подписку»$/,
    );
    assert.ok(out.nodes.some((n) => n.id === 'mini-app:/addons'), 'the add-on page is on the map');
    // Only this template: an expiry notice's renewal button stays the only arrow.
    assert.equal(out.edges.filter((e) => e.id.startsWith('notif-lifetime')).length, 1);

    const bare = composer.compose({ flow: null, replyButtons: [], templates: [limited([])] });
    assert.deepStrictEqual(
      bare.edges.map((e) => [e.id.startsWith('notif-lifetime-default') ? 'lifetime-default' : e.id.startsWith('notif-default') ? 'default' : e.id, e.target]),
      [
        ['default', 'mini-app:/renew'],
        ['lifetime-default', 'mini-app:/addons'],
      ],
    );
    assert.equal(
      bare.edges.find((e) => e.id.startsWith('notif-lifetime-default'))?.sourceLabel,
      'у бессрочной подписки, если ей есть что докупить',
    );
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

  it('draws a button to `/subscribe` to «Тарифы», where the cabinet now sends it, and one to a page it does not have red', () => {
    // The cabinet had no `/subscribe` page and showed its home screen; since
    // 23.09.2026 it sends `/subscribe` on to the plans page, query kept
    // (reiwa `SubscribeAlias`). The route model follows (`MINI_APP_PAGE_ALIASES`).
    const out = makeComposer().compose({
      flow: null,
      replyButtons: [],
      templates: [
        notification([{ target: '/subscribe?plan=pro' }, { target: '/plans' }, { target: 'renew' }, { target: '/subscribed' }]),
      ] as never,
    });
    const [subscribe, plans, renew, typo] = out.edges.filter((e) => e.source === 'notif:trial_ended');
    assert.equal(subscribe?.valid, true);
    assert.equal(subscribe?.target, 'mini-app:/plans');
    assert.deepStrictEqual(subscribe?.destination, { kind: 'webApp', route: '/subscribe?plan=pro' });
    assert.equal(plans?.valid, true);
    assert.equal(plans?.target, 'mini-app:/plans');
    // A page typed without its slash: the bot gives it one.
    assert.equal(renew?.valid, true);
    assert.equal(renew?.target, 'mini-app:/renew');
    assert.equal(typo?.valid, false);
    assert.equal(typo?.reason, 'unknown-mini-app-route');
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

  /**
   * The panel seeds «Открыть приложение» as a Mini App button with no page
   * (`DEFAULT_BUTTONS`, `internal-bot-config.service.ts`), and reiwa opens the
   * Mini App's own address for it (`miniAppButtonUrl` in `main-keyboard.ts`) —
   * whose home sends a Mini App launch on to the dashboard. The map read the
   * missing page as an unsafe address and drew the menu's first button red.
   */
  it('draws a menu «Mini App» button with no page to the Mini App’s home, where the bot opens it', () => {
    const out = makeComposer().compose({
      flow: null,
      replyButtons: [
        replyButton({ buttonId: 'webapp', actionType: BotButtonAction.WEBAPP, actionTarget: null }),
        replyButton({ buttonId: 'blank', actionType: BotButtonAction.WEBAPP, actionTarget: '   ' }),
      ] as never,
      templates: [],
    });
    for (const id of ['reply-btn:reply-webapp', 'reply-btn:reply-blank']) {
      const edge = out.edges.find((e) => e.id === id);
      assert.equal(edge?.valid, true, id);
      assert.equal(edge?.target, 'mini-app:/dashboard', id);
      assert.deepStrictEqual(edge?.destination, { kind: 'webApp', route: '/' }, id);
    }
    assert.ok(out.nodes.some((n) => n.id === 'mini-app:/dashboard'));
  });

  it('keeps a screen’s «Mini App» button with no page red: the bot leaves that one out', () => {
    const blank = {
      ...(HELP_SCREEN as unknown as { buttons: Array<Record<string, unknown>> }).buttons[0],
      id: 'btn-blank',
      webAppUrl: '',
    };
    const flow = {
      ...(PUBLISHED_FLOW as unknown as Record<string, unknown>),
      screens: [{ ...(HELP_SCREEN as unknown as Record<string, unknown>), buttons: [blank] }],
    };
    const out = makeComposer().compose({ flow: flow as never, replyButtons: [], templates: [] });
    assert.equal(out.edges.find((e) => e.id === 'flow-btn:btn-blank')?.valid, false);
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

/**
 * The menu node is the bot's main menu: reiwa sends it as the inline keyboard
 * under the greeting and never a reply keyboard, and «Reply-клавиатура» sent
 * operators to the wrong editor.
 */
describe('the main menu on «Карта бота»', () => {
  it('is called «Главное меню»', () => {
    const out = makeComposer().compose({ flow: null, replyButtons: [], templates: [] });
    const menu = out.nodes.find((n) => n.kind === 'reply-keyboard');
    assert.equal(menu?.title, 'Главное меню');
  });
});

/**
 * A notification's «callback» button, drawn the way reiwa answers the tap.
 *
 * The editor's callback field is free text (the API takes any string of 1 to
 * 2000 characters), it has never offered a list, and the shipped defaults write
 * only `menu:main`. reiwa answers `menu:main`, `menu`, `back_to_menu`,
 * `screen:<shortId>`, a callback that is exactly a screen's shortId, the
 * built-in `invite` / `rules` / `help` and a few service words (`start.ts`,
 * `dynamic-screen.ts` and the rest of `src/bot/pages/**` since 23.09.2026);
 * anything else gets «Меню обновилось» and the main menu instead of what the
 * button says (`stale-button.ts`, since 24.09.2026), and the map draws it red.
 */
describe('a notification callback on «Карта бота»', () => {
  const now = new Date();
  const screen = (id: string, shortId: string, name: string) => ({
    ...(HELP_SCREEN as unknown as Record<string, unknown>),
    id,
    shortId,
    name,
    buttons: [],
  });
  const flow = {
    ...(PUBLISHED_FLOW as unknown as Record<string, unknown>),
    screens: [screen('screen-promo', 'sc_promo', 'promo'), screen('screen-invite', 'sc_invite', 'invite')],
  };
  const edgeFor = (target: string) => {
    const out = makeComposer().compose({
      flow: flow as never,
      replyButtons: [],
      templates: [
        {
          id: 'tpl-cb',
          type: 'callback_probe',
          title: 'Проба',
          body: 'Проба',
          titleEn: null,
          bodyEn: null,
          isActive: true,
          buttons: [{ labelRu: 'Кнопка', labelEn: null, kind: 'callback', target }],
          createdAt: now,
          updatedAt: now,
        },
      ] as never,
    });
    const edge = out.edges.find((e) => e.source === 'notif:callback_probe');
    assert.ok(edge, target);
    return edge;
  };

  it('draws `screen:<shortId>` — what «Экран бота» sends — to that screen', () => {
    const edge = edgeFor('screen:sc_promo');
    assert.equal(edge.valid, true);
    assert.equal(edge.target, 'screen-promo');
    assert.deepStrictEqual(edge.destination, { kind: 'screen', shortId: 'sc_promo' });
  });

  it('draws `screen:` with no such screen red: the bot answers «Меню обновилось», not that screen', () => {
    const edge = edgeFor('screen:sc_gone');
    assert.equal(edge.valid, false);
    assert.equal(edge.reason, 'unknown-shortid');
  });

  it('draws `menu:main` and `back_to_menu` to the main menu', () => {
    for (const target of ['menu:main', 'back_to_menu']) {
      const edge = edgeFor(target);
      assert.equal(edge.valid, true, target);
      assert.equal(edge.target, '__reply_keyboard__', target);
      assert.deepStrictEqual(edge.destination, { kind: 'mainMenu' }, target);
    }
  });

  it('draws `invite` to the invite screen, which the bot’s own handler renders', () => {
    const edge = edgeFor('invite');
    assert.equal(edge.valid, true);
    assert.equal(edge.target, 'screen-invite');
  });

  it('draws `menu` to the main menu and a bare shortId to its screen — reiwa answers both', () => {
    const menu = edgeFor('menu');
    assert.equal(menu.valid, true);
    assert.equal(menu.target, '__reply_keyboard__');
    const bare = edgeFor('sc_promo');
    assert.equal(bare.valid, true);
    assert.equal(bare.target, 'screen-promo');
  });

  it('leaves a callback the bot answers without a screen a callback, with no arrow', () => {
    const edge = edgeFor('lang:en');
    assert.equal(edge.valid, true);
    assert.equal(edge.target, 'callback:lang:en');
  });

  it('draws red a callback nothing in the bot answers', () => {
    const edge = edgeFor('subscription');
    assert.equal(edge.valid, false);
    assert.equal(edge.reason, 'unanswered-callback');
    assert.deepStrictEqual(edge.destination, { kind: 'callback', id: 'subscription' });
  });
});

/**
 * A main-menu button, drawn in «Список» the way «Схема» captions it: both go
 * through the one route model (`menu-button-route.ts` here, its copy in the
 * SPA, pinned together by `bot-map-route-parity.spec.ts`).
 */
describe('a main-menu button on «Список»', () => {
  const now = new Date();
  const screen = (id: string, shortId: string, name: string) => ({
    ...(HELP_SCREEN as unknown as Record<string, unknown>),
    id,
    shortId,
    name,
    buttons: [],
  });
  const flow = {
    ...(PUBLISHED_FLOW as unknown as Record<string, unknown>),
    screens: [
      screen('screen-promo', 'sc_promo', 'promo'),
      screen('screen-invite', 'sc_invite', 'invite'),
      screen('screen-help', 'sc_help', 'help'),
    ],
  };
  const edgeOf = (
    buttonId: string,
    actionType: BotButtonAction,
    actionTarget: string | null = null,
    supportUsername: string | null = null,
  ) => {
    const out = makeComposer().compose({
      supportUsername,
      flow: flow as never,
      replyButtons: [
        {
          id: `row-${buttonId}`,
          buttonId,
          label: buttonId,
          style: BotButtonStyle.DEFAULT,
          iconCustomEmojiId: null,
          visible: true,
          onePerRow: true,
          orderIndex: 0,
          actionType,
          actionTarget,
          createdAt: now,
          updatedAt: now,
        },
      ] as never,
      templates: [],
    });
    const edge = out.edges.find((e) => e.id === `reply-btn:row-${buttonId}`);
    assert.ok(edge, buttonId);
    return edge;
  };

  it('draws `menu` as the main menu and a screen’s shortId as that screen, as the bot answers them', () => {
    assert.deepStrictEqual(edgeOf('menu', BotButtonAction.CALLBACK).destination, { kind: 'mainMenu' });
    const bare = edgeOf('sc_promo', BotButtonAction.CALLBACK);
    assert.equal(bare.valid, true);
    assert.equal(bare.target, 'screen-promo');
  });

  it('draws `invite` to the invite screen, and a callback nothing answers red', () => {
    assert.equal(edgeOf('invite', BotButtonAction.CALLBACK).target, 'screen-invite');
    const dead = edgeOf('subscription', BotButtonAction.CALLBACK);
    assert.equal(dead.valid, false);
    assert.equal(dead.reason, 'unanswered-callback');
    // An answered service word is not dead.
    assert.equal(edgeOf('close', BotButtonAction.CALLBACK).valid, true);
  });

  it('draws a «Внешняя ссылка» typed as a path, or with none, as a page of the cabinet — not an unsafe URL', () => {
    const plans = edgeOf('plans', BotButtonAction.URL, 'plans');
    assert.equal(plans.valid, true);
    assert.deepStrictEqual(plans.destination, { kind: 'site', path: '/plans' });
    assert.deepStrictEqual(edgeOf('site', BotButtonAction.URL, null).destination, { kind: 'site', path: '/' });
  });

  it('keeps an http address of a link button working — the bot sends it as typed — and a local one red', () => {
    assert.equal(edgeOf('news', BotButtonAction.URL, 'http://example.com/news').valid, true);
    const local = edgeOf('dev', BotButtonAction.URL, 'https://localhost:5173/');
    assert.equal(local.valid, false);
    assert.equal(local.reason, 'unsafe-url');
  });

  it('draws red a Mini App on http (the bot leaves it out), a page the cabinet lacks and a screen that is gone', () => {
    const http = edgeOf('app', BotButtonAction.WEBAPP, 'http://example.com/app');
    assert.equal(http.valid, false);
    assert.equal(http.reason, 'unsafe-webapp');
    assert.equal(edgeOf('promo', BotButtonAction.WEBAPP, '/promoo').reason, 'unknown-mini-app-route');
    assert.equal(edgeOf('gone', BotButtonAction.SCREEN, 'sc_gone').reason, 'unknown-shortid');
  });

  it('routes a «Экран бота» button with no screen chosen by its ID, as the bot sends it', () => {
    assert.equal(edgeOf('invite', BotButtonAction.SCREEN, null).target, 'screen-invite');
  });

  /**
   * reiwa from 23.09.2026: a «Чат с поддержкой» button with no public support
   * @username sends `help` — the help screen — whatever its own ID; it sent
   * the ID before, which nothing answered for `support`. The panel's own
   * «Username поддержки» says which: a numeric id is never public, and reiwa
   * then does not read its `.env`.
   */
  it('draws a support button without a public @username to the help screen, whatever its ID', () => {
    for (const buttonId of ['help', 'support']) {
      const edge = edgeOf(buttonId, BotButtonAction.SUPPORT_URL, null, '123456789');
      assert.equal(edge.target, 'screen-help', buttonId);
      assert.equal(edge.valid, true, buttonId);
    }
  });

  it('draws a support button with a public @username as the chat', () => {
    assert.deepStrictEqual(edgeOf('support', BotButtonAction.SUPPORT_URL, null, '@support_team').destination, {
      kind: 'chat',
    });
  });

  it('draws one with no «Username поддержки» as «Схема» does: the chat, or without a public one the help screen', () => {
    // reiwa's `.env` decides, which the panel cannot see; with no public
    // `BOT_SUPPORT_USERNAME` either — the default setup — the tap opens `help`.
    for (const username of [null, '', '   ']) {
      assert.deepStrictEqual(
        edgeOf('support', BotButtonAction.SUPPORT_URL, null, username).destination,
        { kind: 'chat', fallbackScreen: 'help' },
        JSON.stringify(username),
      );
    }
  });

  it('reads the «Username поддержки» from the text row the bot reads it from', async () => {
    const button = {
      id: 'row-support',
      buttonId: 'support',
      label: 'Поддержка',
      style: BotButtonStyle.DEFAULT,
      iconCustomEmojiId: null,
      visible: true,
      onePerRow: true,
      orderIndex: 0,
      actionType: BotButtonAction.SUPPORT_URL,
      actionTarget: null,
      createdAt: now,
      updatedAt: now,
    };
    const composer = new BotMapComposerService(
      { getDraft: async () => null } as never,
      { listAll: async () => [button] } as never,
      { listAll: async () => [] } as never,
      { listAll: async () => [{ key: 'bot.support_username', value: ' 123456789 ' }] } as never,
    );
    const edge = (await composer.build()).edges.find((e) => e.id === 'reply-btn:row-support');
    // No flow: the bot's own help screen, which the map has no node for.
    assert.deepStrictEqual(edge?.destination, { kind: 'callback', id: 'help' });
  });
});

/** A screen's own «CALLBACK» button speaks the same vocabulary as a menu or notification button. */
describe('a screen’s «CALLBACK» button on «Список»', () => {
  const now = new Date();
  const withCallback = (callbackAction: string) => ({
    ...(HELP_SCREEN as unknown as Record<string, unknown>),
    buttons: [
      {
        ...(HELP_SCREEN as unknown as { buttons: Array<Record<string, unknown>> }).buttons[0],
        id: 'btn-cb',
        actionType: BotFlowButtonAction.CALLBACK,
        webAppUrl: null,
        callbackAction,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
  const edgeFor = (callbackAction: string) => {
    const flow = { ...(PUBLISHED_FLOW as unknown as Record<string, unknown>), screens: [withCallback(callbackAction)] };
    const edge = makeComposer()
      .compose({ flow: flow as never, replyButtons: [], templates: [] })
      .edges.find((e) => e.id === 'flow-btn:btn-cb');
    assert.ok(edge, callbackAction);
    return edge;
  };

  it('draws `menu:main` to the main menu, `screen:<shortId>` to the screen, and a word nothing answers red', () => {
    assert.deepStrictEqual(edgeFor('menu:main').destination, { kind: 'mainMenu' });
    assert.equal(edgeFor('screen:sc_help').target, 'screen-help');
    assert.equal(edgeFor('nothing_answers_this').reason, 'unanswered-callback');
  });
});

/**
 * A screen's «Ссылка» and «Mini App» buttons, read the way reiwa renders them
 * (`buildScreenKeyboard`, `screen-renderer.ts`): an `https://` address whose
 * HOST is not local as typed, a path on the cabinet's public address, the rest
 * left out. The composer kept its own substring rule after the bot and the
 * route model moved to the host (11 inputs apart), and drew a path red as
 * «unsafe-url» while reiwa opens it on the cabinet.
 */
describe('a screen’s link or Mini App button on «Список»', () => {
  const now = new Date();
  const edgeFor = (actionType: BotFlowButtonAction, address: string) => {
    const screen = {
      ...(HELP_SCREEN as unknown as Record<string, unknown>),
      buttons: [
        {
          ...(HELP_SCREEN as unknown as { buttons: Array<Record<string, unknown>> }).buttons[0],
          id: 'btn-link',
          actionType,
          url: actionType === BotFlowButtonAction.URL ? address : null,
          webAppUrl: actionType === BotFlowButtonAction.WEBAPP ? address : null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const flow = { ...(PUBLISHED_FLOW as unknown as Record<string, unknown>), screens: [screen] };
    const edge = makeComposer()
      .compose({ flow: flow as never, replyButtons: [], templates: [] })
      .edges.find((e) => e.id === 'flow-btn:btn-link');
    assert.ok(edge, address);
    return edge;
  };

  it('calls an address local by its host alone, as the shared table says', () => {
    let rows = 0;
    for (const [address, local] of LOCAL_ADDRESS_TABLE) {
      // Only https reaches a screen's button at all; the table's http rows are
      // asked again on https, where locality alone decides.
      const https = address.replace(/^http:\/\//, 'https://');
      if (!https.includes('://')) continue;
      for (const actionType of [BotFlowButtonAction.URL, BotFlowButtonAction.WEBAPP]) {
        assert.equal(edgeFor(actionType, https).valid, !local, `${actionType} ${https}`);
      }
      rows += 1;
    }
    assert.equal(rows, LOCAL_ADDRESS_TABLE.length - 1);
    // Credentials before the host do not hide it; a trailing dot is another host.
    assert.equal(edgeFor(BotFlowButtonAction.URL, 'https://a@localhost/x').valid, false);
    assert.equal(edgeFor(BotFlowButtonAction.URL, 'https://user:pw@127.0.0.1/x').valid, false);
    assert.equal(edgeFor(BotFlowButtonAction.URL, 'https://localhost./x').valid, true);
  });

  it('draws a link typed as a path as a page of the cabinet, where the bot opens it', () => {
    assert.deepStrictEqual(edgeFor(BotFlowButtonAction.URL, '/plans').destination, { kind: 'site', path: '/plans' });
    const bare = edgeFor(BotFlowButtonAction.URL, 'plans');
    assert.deepStrictEqual(bare.destination, { kind: 'site', path: '/plans' });
    assert.equal(bare.valid, true);
  });

  it('keeps red what the bot leaves out: http, another scheme, nothing at all', () => {
    for (const address of ['http://example.com/a', 'tg://resolve?domain=example', '']) {
      const edge = edgeFor(BotFlowButtonAction.URL, address);
      assert.equal(edge.valid, false, address);
      assert.equal(edge.reason, 'unsafe-url', address);
    }
  });
});
