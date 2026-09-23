import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { MINI_APP_TERMINALS } from '../src/modules/bot-map/catalogs/mini-app-terminals.catalog';
import { LOCAL_ADDRESS_TABLE } from './bot-map-local-address-table';
import * as server from '../src/modules/bot-map/services/menu-button-route';
import type * as SpaRoutes from '../web/src/features/bot-flow/components/reply-keyboard-utils';

/**
 * The SPA's copy, loaded as it is. `web/` is an ES module package and this
 * spec runs as CommonJS, so the file cannot be `require`d; a native `import()`
 * loads it, Node stripping its types (the file imports nothing and uses only
 * erasable syntax). Built through `Function` because TypeScript's CommonJS
 * output would turn a written `import()` back into `require`.
 */
const importNative = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
const SPA_ROUTES = resolve(__dirname, '../web/src/features/bot-flow/components/reply-keyboard-utils.ts');
let spa: typeof SpaRoutes;

before(async () => {
  spa = (await importNative(pathToFileURL(SPA_ROUTES).href)) as typeof SpaRoutes;
});

/**
 * «Схема» and «Список» give one answer per button.
 *
 * «Схема» captions a main-menu button in the SPA
 * (`web/src/features/bot-flow/components/reply-keyboard-utils.ts`); «Список»
 * draws the same button, a notification's callback and a screen's CALLBACK
 * button from the composer (`src/modules/bot-map/services/menu-button-route.ts`).
 * Neither build can import the other's files — the server image compiles
 * `src/` alone, the SPA image `web/` alone — so the route model is written
 * twice, and this spec is what keeps it one: the two vocabularies must be
 * equal, and the two functions must return the same route for every case
 * below. The review of 23.09.2026 found them apart on six kinds of button
 * (a relative link read as an unsafe URL on one tab and a cabinet page on the
 * other; `menu` dead on one, the main menu on the other).
 *
 * The same two files hold the rule a main-menu button's address is saved by
 * (`menuButtonTargetProblem`): the server refuses with it
 * (`bot-buttons.service.ts`), the forms warn with it before the request, and
 * the two must refuse the same targets.
 */

const CONTEXT: server.RouteContext = {
  screens: [
    { shortId: 'sc_help', name: 'help' },
    { shortId: 'sc_rules', name: 'Rules' },
    { shortId: 'sc_promo', name: 'promo' },
    // A repeated name: reiwa's `findScreenByName` takes the first.
    { shortId: 'help2', name: 'help' },
    // A shortId spelled like a word the bot answers: the word wins.
    { shortId: 'close', name: 'closer' },
    { shortId: 'abcdefgh', name: 'Акция' },
  ],
  miniAppRoutes: new Set(MINI_APP_TERMINALS.map((terminal) => terminal.route)),
  supportChat: null,
};

/** Each context the map routes in: pages known or not; a public support @username, none, or unknown. */
const CONTEXTS: readonly server.RouteContext[] = [
  CONTEXT,
  { ...CONTEXT, miniAppRoutes: null },
  { ...CONTEXT, supportChat: true },
  { ...CONTEXT, supportChat: false },
];

const QUEST = 'cabcdefghijklmnopqrst';

/** Callback data: every word of either vocabulary, each pattern either side of its edge, shortIds, collisions. */
const callbacks = (): readonly string[] => [
  ...spa.CALLBACK_VOCABULARY.builtInScreens,
  ...spa.CALLBACK_VOCABULARY.mainMenu,
  ...spa.CALLBACK_VOCABULARY.answered,
  ...server.CALLBACK_VOCABULARY.builtInScreens,
  ...server.CALLBACK_VOCABULARY.mainMenu,
  ...server.CALLBACK_VOCABULARY.answered,
  'check_channel',
  'CHECK_CHANNEL',
  `check_channel:q:${QUEST}`,
  'check_channel:q:bad',
  'lang:en',
  'lang:',
  `quest_channel:${QUEST}`,
  'quest_channel:short',
  'screen:sc_promo',
  'screen:sc_gone',
  'screen:',
  'screen:close',
  'sc_promo',
  'abcdefgh',
  'Help',
  'MENU',
  'menu:mai',
  '',
  'subscription',
];

const IDS: readonly string[] = ['invite', 'help', 'menu', 'cabinet', 'site', 'sc_promo', 'close', 'subscription'];
const TARGETS: ReadonlyArray<string | null> = [
  null,
  '',
  '   ',
  '/',
  'plans',
  '/plans',
  '/plans?code=SALE',
  '/dashboard?connect=help',
  '/promoo',
  '#top',
  'sc_promo',
  '  sc_promo  ',
  'sc_gone',
  'https://example.com/a',
  'http://example.com/a',
  'HTTPS://Example.com/b',
  'https://localhost:5173/',
  'http://127.0.0.1/x',
  'ftp://files.example.com',
];
const ACTIONS: ReadonlyArray<server.MenuButtonRouting['actionType']> = [
  'CALLBACK',
  'URL',
  'WEBAPP',
  'SCREEN',
  'SUPPORT_URL',
];

describe('«Схема» and «Список» route a button the same way', () => {
  it('know the same callback vocabulary', () => {
    assert.deepStrictEqual(
      server.CALLBACK_VOCABULARY,
      spa.CALLBACK_VOCABULARY,
      'The composer and the SPA disagree on what reiwa answers — change both, or neither.',
    );
    assert.equal(server.MINI_APP_HOME_PAGE, spa.MINI_APP_HOME_PAGE);
    assert.equal(server.SUPPORT_FALLBACK_CALLBACK, spa.SUPPORT_FALLBACK_CALLBACK);
  });

  it('route every callback the same way', () => {
    for (const data of callbacks()) {
      assert.deepStrictEqual(server.callbackRoute(data, CONTEXT), spa.callbackRoute(data, CONTEXT), JSON.stringify(data));
    }
  });

  it('read a support @username the same way', () => {
    const usernames = ['', '   ', '@', ' @', '@@', 'support_bot', '@support_bot', ' @support_bot ', '@@support_bot', '123456789', '-1001234567', '@123', 'x1', null, undefined];
    for (const username of usernames) {
      assert.equal(server.supportChatOf(username), spa.supportChatOf(username), JSON.stringify(username));
    }
  });

  it('refuse the same targets, and call the same addresses local', () => {
    const TAB = String.fromCharCode(9);
    const DEL = String.fromCharCode(127);
    // Invisible in this file, so written by code point: C1, zero-width, bidi.
    const invisible = [0x85, 0x9f, 0x200b, 0x202e, 0x2060, 0xfeff].map((code) => `/a${String.fromCodePoint(code)}b`);
    const more = [
      '//evil.example',
      '/\\evil.example',
      '/pl ans',
      `/tab${TAB}x`,
      `/del${DEL}`,
      '/',
      '/промо',
      ...invisible,
      'HTTP://example.com',
      'Https://example.com/app',
      'https://exa mple.com',
      'https://',
      'https://example.com/a b',
      'http://LOCALHOST:3000/',
      'https://127.0.0.1:8443/x',
      'https://example.com/?next=http://localhost/x',
      '/r?next=http://localhost/x',
      ...LOCAL_ADDRESS_TABLE.map(([address]) => address),
    ];
    let cases = 0;
    for (const actionType of ACTIONS) {
      for (const actionTarget of [...TARGETS, ...more]) {
        assert.equal(
          server.menuButtonTargetProblem(actionType, actionTarget),
          spa.menuButtonTargetProblem(actionType, actionTarget),
          JSON.stringify({ actionType, actionTarget }),
        );
        if (actionTarget !== null) {
          assert.equal(server.isLocalAddress(actionTarget), spa.isLocalAddress(actionTarget), JSON.stringify(actionTarget));
        }
        cases += 1;
      }
    }
    assert.equal(cases, ACTIONS.length * (TARGETS.length + more.length));
  });

  it('route every main-menu button the same way, in every context', () => {
    let cases = 0;
    for (const context of CONTEXTS) {
      for (const actionType of ACTIONS) {
        for (const buttonId of IDS) {
          for (const actionTarget of TARGETS) {
            const button = { buttonId, actionType, actionTarget };
            assert.deepStrictEqual(
              server.menuButtonRoute(button, context),
              spa.menuButtonRoute(button, context),
              JSON.stringify(button),
            );
            cases += 1;
          }
        }
      }
    }
    assert.equal(cases, CONTEXTS.length * ACTIONS.length * IDS.length * TARGETS.length);
  });

  it('answer what reiwa answers on the cases the review found apart', () => {
    const route = (buttonId: string, actionType: server.MenuButtonRouting['actionType'], actionTarget: string | null) =>
      server.menuButtonRoute({ buttonId, actionType, actionTarget }, CONTEXT);
    // `menu` is `menu:main` (reiwa `start.ts`); a bare shortId opens its screen (`dynamic-screen.ts`).
    assert.deepStrictEqual(route('menu', 'CALLBACK', null), { kind: 'mainMenu' });
    assert.deepStrictEqual(route('sc_promo', 'CALLBACK', null), { kind: 'screen', name: 'promo', shortId: 'sc_promo' });
    // A shortId spelled like a word the bot answers stays that word.
    assert.deepStrictEqual(route('close', 'CALLBACK', null), { kind: 'answered', data: 'close' });
    // The first screen of a repeated name.
    assert.deepStrictEqual(route('help', 'CALLBACK', null), { kind: 'screen', name: 'help', shortId: 'sc_help' });
    // A relative or empty «Внешняя ссылка» is a page of the cabinet (`addressOn`), with its slash.
    assert.deepStrictEqual(route('site', 'URL', 'plans'), { kind: 'site', path: '/plans' });
    assert.deepStrictEqual(route('site', 'URL', null), { kind: 'site', path: '/' });
    // A Mini App on http is left out (`isTelegramSafeButtonUrl`); a link on http is sent.
    assert.deepStrictEqual(route('app', 'WEBAPP', 'http://example.com/a'), { kind: 'url', host: 'example.com', safe: false });
    assert.deepStrictEqual(route('news', 'URL', 'http://example.com/a'), { kind: 'url', host: 'example.com', safe: true });
    assert.deepStrictEqual(route('subscription', 'CALLBACK', null), { kind: 'unanswered', data: 'subscription' });
  });

  it('send a support button without a public @username to the help screen, whatever its ID', () => {
    const help = { kind: 'screen', name: 'help', shortId: 'sc_help' } as const;
    const support = (context: server.RouteContext) =>
      server.menuButtonRoute({ buttonId: 'support', actionType: 'SUPPORT_URL', actionTarget: null }, context);
    // A numeric id in «Username поддержки»: never a chat (reiwa `resolveSupportDeepLink`).
    assert.deepStrictEqual(support({ ...CONTEXT, supportChat: server.supportChatOf('123456789') }), help);
    // A public @username: the chat, nothing to fall back to.
    assert.deepStrictEqual(support({ ...CONTEXT, supportChat: server.supportChatOf('@support_team') }), { kind: 'support', fallback: null });
    // Empty: reiwa's `.env` decides — the chat, or the help screen; never the button's own ID.
    assert.deepStrictEqual(support({ ...CONTEXT, supportChat: server.supportChatOf('') }), { kind: 'support', fallback: help });
  });

  it('call an address local by its host alone, both of them, as the shared table says', () => {
    for (const [address, local] of LOCAL_ADDRESS_TABLE) {
      assert.equal(server.isLocalAddress(address), local, `server ${address}`);
      assert.equal(spa.isLocalAddress(address), local, `SPA ${address}`);
    }
  });

  it('take a page of the cabinet, as the page picker saves it, and refuse what the bot cannot open', () => {
    const problem = server.menuButtonTargetProblem;
    for (const page of MINI_APP_TERMINALS.map((terminal) => terminal.route)) {
      assert.equal(problem('WEBAPP', page), null, page);
      assert.equal(problem('URL', page), null, page);
    }
    assert.equal(problem('URL', '/promo?code=SALE'), null);
    assert.equal(problem('URL', 'http://example.com/a'), null);
    assert.equal(problem('WEBAPP', 'https://example.com/app'), null);
    assert.equal(problem('URL', 'plans'), 'notAPage');
    assert.equal(problem('URL', '//evil.example'), 'notAPage');
    assert.equal(problem('URL', '/\\evil.example'), 'badCharacters');
    assert.equal(problem('WEBAPP', '/pl ans'), 'badCharacters');
    assert.equal(problem('WEBAPP', 'http://example.com/app'), 'webAppNeedsHttps');
    assert.equal(problem('URL', 'http://localhost:5173/'), 'localAddress');
    assert.equal(problem('WEBAPP', 'https://127.0.0.1/app'), 'localAddress');
    // A local address named in a query is not a local host.
    assert.equal(problem('URL', 'https://example.com/?next=http://localhost/x'), null);
    // reiwa keeps a Mini App only on `https://` as written; a link goes out as typed.
    assert.equal(problem('WEBAPP', 'Https://example.com/app'), 'upperCaseScheme');
    assert.equal(problem('WEBAPP', 'HTTPS://example.com/app'), 'upperCaseScheme');
    assert.equal(problem('URL', 'HTTPS://example.com/a'), null);
    // An address must parse, with a site and no whitespace.
    assert.equal(problem('URL', 'https://exa mple.com'), 'notAnAddress');
    assert.equal(problem('WEBAPP', 'https://'), 'notAnAddress');
    // Invisible characters in a path: C1, zero-width, bidi.
    for (const code of [0x85, 0x200b, 0x202e, 0xfeff]) {
      assert.equal(problem('URL', `/a${String.fromCodePoint(code)}b`), 'badCharacters', code.toString(16));
    }
    assert.equal(problem('URL', '/промо'), null);
    // Only the two kinds with an address have one to refuse.
    assert.equal(problem('SCREEN', 'plans'), null);
  });
});
