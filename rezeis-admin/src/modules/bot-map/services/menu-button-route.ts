/**
 * Where the bot sends a tap — the route model «Карта бота» draws from.
 * ───────────────────────────────────────────────────────────────────
 * ONE ROUTE MODEL IN TWO BUILDS. «Схема» routes the main menu's buttons in the
 * SPA (`web/src/features/bot-flow/components/reply-keyboard-utils.ts`), and
 * this file is a copy of that section for the composer, which draws «Список»:
 * neither build can import the other's files (the server image compiles `src/`
 * alone, the SPA image `web/` alone). `test/bot-map-route-parity.spec.ts`
 * loads both and fails when their vocabularies differ or when they route any
 * case of its matrix differently. Change both, or neither.
 *
 * `buttonTargetProblem` is also what the server refuses a button's target with
 * wherever one is saved — a main-menu button (`bot-config/services/bot-buttons.service.ts`),
 * a screen's (`bot-flow/services/bot-flow-screen.service.ts`), a notification's
 * (`notifications/services/notification-templates.service.ts`), all through
 * `button-target-refusal.ts` — and what the SPA's forms say before saving: the
 * same check on both sides, held equal by the same spec.
 */

/** A main-menu button as far as its route goes — the `BotButton` fields reiwa reads. */
export interface MenuButtonRouting {
  readonly buttonId: string;
  readonly actionType: 'CALLBACK' | 'URL' | 'WEBAPP' | 'SCREEN' | 'SUPPORT_URL';
  readonly actionTarget: string | null;
}

/** A screen as reiwa finds it in `BotConfig.screens`. */
export interface RouteScreen {
  readonly shortId: string;
  readonly name: string;
}

/** What a route depends on besides the button. */
export interface RouteContext {
  /** The flow's screens, in flow order (reiwa takes the FIRST of a repeated name). */
  readonly screens: ReadonlyArray<RouteScreen>;
  /** The cabinet's Mini App pages (the map's catalog); `null` while not known — every path then counts. */
  readonly miniAppRoutes: ReadonlySet<string> | null;
  /** Whether a «Чат с поддержкой» button opens a chat (`supportChatOf`); `null` when the panel cannot tell. */
  readonly supportChat: boolean | null;
}

/**
 * reiwa's callback vocabulary — every callback data a handler answers
 * (`src/bot/pages/**`, registered in `main.ts` order), read 23.09.2026:
 *   • `builtInScreens` — `bot.callbackQuery('help' | 'rules' | 'invite')`, each
 *     rendering the flow screen of its name when there is one;
 *   • `mainMenu` — `menu:main` and `menu` (`start.ts`, one handler) and
 *     `back_to_menu` (`menu.ts`);
 *   • `answered` / `answeredPatterns` — answered, but not with a screen of the
 *     map: `close` (deletes the message), leaving AI support, «Я подписался»
 *     (`menu.ts`), the language picker (`lang.ts`), a channel quest's check;
 *   • `screenPrefix` — `screen:<shortId>` (`dynamic-screen.ts`).
 * Then, a callback that is exactly the shortId of a flow screen opens that
 * screen too (`dynamic-screen.ts`, registered after every page above, so the
 * words above win over a screen spelled like them). Anything else — an old
 * button the bot no longer knows — gets the pop-up «Меню обновилось» and the
 * main menu in place of its message (`stale-button.ts`, the very last handler,
 * from 24.09.2026; it used to spin and get nothing). Still a button that does
 * not do what it says: the map draws it red.
 */
export const CALLBACK_VOCABULARY = {
  builtInScreens: ['help', 'rules', 'invite'],
  mainMenu: ['menu:main', 'menu', 'back_to_menu'],
  answered: ['close', 'ai_support_exit'],
  answeredPatterns: [
    { source: '^check_channel(?::q:([a-z][a-z0-9]{19,31}))?$', flags: 'i' },
    { source: '^lang:(.+)$', flags: '' },
    { source: '^quest_channel:([a-z][a-z0-9]{19,31})$', flags: 'i' },
  ],
  screenPrefix: 'screen:',
} as const;

/** The page a Mini App button with no page of its own lands on: its home sends a launch on to the dashboard. */
export const MINI_APP_HOME_PAGE = '/dashboard';

/**
 * Pages of the cabinet that open another page, and the page each opens.
 * `/subscribe` is the plans page (reiwa `web/src/App.tsx`, `SubscribeAlias`,
 * from 23.09.2026, its query kept): «Карта бота» offered it as «Покупка
 * подписки» and the legacy «vpn» button opened it, so buttons are saved with
 * it, and the cabinet takes every one of them to «Тарифы». The map draws such
 * a button to the page it lands on; the page picker does not offer the alias
 * (`mini-app-terminals.catalog.ts`) — a new button is set to the page itself.
 * `web/src/features/bot-flow/system-screens.reiwa.parity.test.ts` holds each
 * alias to reiwa's route table.
 */
export const MINI_APP_PAGE_ALIASES: Readonly<Record<string, string>> = { '/subscribe': '/plans' };

/**
 * The page a Mini App path lands on: the path without its query and fragment
 * (they are what the page is asked, not which page), the dashboard for the
 * Mini App's root, the page an alias opens for an alias.
 */
export function miniAppLandingPage(path: string): string {
  const cut = path.search(/[?#]/);
  const bare = cut === -1 ? path : path.slice(0, cut);
  if (bare === '/') return MINI_APP_HOME_PAGE;
  return Object.prototype.hasOwnProperty.call(MINI_APP_PAGE_ALIASES, bare) ? MINI_APP_PAGE_ALIASES[bare] : bare;
}

/**
 * What a «Чат с поддержкой» button sends when there is no public support
 * @username to open: `help`, whose handler shows the help screen (reiwa
 * `main-keyboard.ts`, from 23.09.2026 — the button's own ID before, which
 * nothing answered for any ID but `help`).
 */
export const SUPPORT_FALLBACK_CALLBACK = 'help';

/**
 * Whether the panel's «Username поддержки» opens a support chat, read the way
 * reiwa reads it (`resolveConfiguredSupportUrl`, then `resolveSupportDeepLink`):
 * `true` for a public @username; `false` for anything else that is set — a
 * numeric id — since reiwa then never looks at its own `.env`; `null` when it
 * is empty, and reiwa's `BOT_SUPPORT_USERNAME`, which the panel cannot see,
 * decides.
 */
export function supportChatOf(username: string | null | undefined): boolean | null {
  const set = (username ?? '').replace(/^@+/, '').trim();
  if (set.length === 0) return null;
  const handle = set.replace(/^@+/, '').trim();
  return handle.length > 0 && !/^-?\d+$/.test(handle);
}

export type CallbackRoute =
  /** A screen; `shortId` is `null` for a built-in one the flow has no screen of that name for. */
  | { readonly kind: 'screen'; readonly name: string; readonly shortId: string | null }
  | { readonly kind: 'mainMenu' }
  /** Answered, and not with a screen of the map. */
  | { readonly kind: 'answered'; readonly data: string }
  /** `screen:<shortId>` of a screen the flow does not have: the bot answers «Меню обновилось» and the main menu. */
  | { readonly kind: 'missingScreen'; readonly shortId: string }
  /** No word the bot knows: it answers «Меню обновилось» and the main menu, not what the button says. */
  | { readonly kind: 'unanswered'; readonly data: string };

export type MenuButtonRoute =
  | CallbackRoute
  /**
   * The support chat. `fallback` is where the tap goes instead when there is
   * no public support @username (`SUPPORT_FALLBACK_CALLBACK`); `null` when the
   * panel knows there is one.
   */
  | { readonly kind: 'support'; readonly fallback: CallbackRoute | null }
  /** «Кабинет» with no address: the Mini App's `/open-in-browser`. */
  | { readonly kind: 'cabinetBrowser' }
  /** A Mini App page: `path` as the button opens it, `page` the route it lands on. */
  | { readonly kind: 'miniApp'; readonly path: string; readonly page: string; readonly known: boolean }
  /** A page of the cabinet website: `publicWebUrl` + `path`. */
  | { readonly kind: 'site'; readonly path: string }
  /** An address typed in full; `safe` is whether the bot's button can carry it. */
  | { readonly kind: 'url'; readonly host: string; readonly safe: boolean };

/** Where reiwa sends a callback with this data. */
export function callbackRoute(data: string, ctx: RouteContext): CallbackRoute {
  const vocabulary = CALLBACK_VOCABULARY;
  if ((vocabulary.builtInScreens as readonly string[]).includes(data)) {
    const screen = ctx.screens.find((candidate) => candidate.name.toLowerCase() === data);
    return { kind: 'screen', name: screen?.name ?? data, shortId: screen?.shortId ?? null };
  }
  if ((vocabulary.mainMenu as readonly string[]).includes(data)) return { kind: 'mainMenu' };
  if (
    (vocabulary.answered as readonly string[]).includes(data) ||
    vocabulary.answeredPatterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(data))
  ) {
    return { kind: 'answered', data };
  }
  if (data.startsWith(vocabulary.screenPrefix) && data.length > vocabulary.screenPrefix.length) {
    const shortId = data.slice(vocabulary.screenPrefix.length);
    const screen = ctx.screens.find((candidate) => candidate.shortId === shortId);
    return screen === undefined ? { kind: 'missingScreen', shortId } : { kind: 'screen', name: screen.name, shortId };
  }
  const bare = ctx.screens.find((candidate) => candidate.shortId === data);
  if (bare !== undefined) return { kind: 'screen', name: bare.name, shortId: bare.shortId };
  return { kind: 'unanswered', data };
}

/**
 * Where reiwa sends a tap on a main-menu button — `resolveButtonBinding` and
 * `buildMainKeyboard` in `src/bot/widgets/main-keyboard.ts`, read the same way:
 *   • «Внутренняя кнопка» sends the button's ID as the callback;
 *   • «Экран бота» sends `screen:<shortId>`, and with no screen chosen falls
 *     back to the button's ID like a callback;
 *   • «Чат с поддержкой» opens the chat, or — with no public support
 *     @username — sends `help` (`SUPPORT_FALLBACK_CALLBACK`): the help screen,
 *     whatever the button's ID. Where the panel's own setting says there is no
 *     such @username, that is the whole route;
 *   • «Внешняя ссылка» opens an `http(s)://` address as typed, anything else as
 *     a page of the cabinet website (`addressOn`: given the slash it lacks, the
 *     cabinet's root with none); «Кабинет» with none opens the cabinet in the
 *     phone's browser through the Mini App (`isDefaultCabinet`);
 *   • «Mini App» opens its path on the Mini App, its home with none; an address
 *     typed in full is kept only if it is https (`isTelegramSafeButtonUrl`).
 * The button's ID alone decides nothing: a «Пригласить» set to another screen
 * opens that screen.
 */
export function menuButtonRoute(button: MenuButtonRouting, ctx: RouteContext): MenuButtonRoute {
  const target = (button.actionTarget ?? '').trim();
  switch (button.actionType) {
    case 'SCREEN':
      return callbackRoute(target.length > 0 ? `${CALLBACK_VOCABULARY.screenPrefix}${target}` : button.buttonId, ctx);
    case 'SUPPORT_URL': {
      const help = callbackRoute(SUPPORT_FALLBACK_CALLBACK, ctx);
      if (ctx.supportChat === false) return help;
      return { kind: 'support', fallback: ctx.supportChat === true ? null : help };
    }
    case 'URL':
      if (button.buttonId === 'cabinet' && target.length === 0) return { kind: 'cabinetBrowser' };
      if (ABSOLUTE_ADDRESS.test(target)) {
        // Sent as typed, but not a local address: Telegram refuses one, and
        // reiwa leaves such a button out, as it does a Mini App's.
        return { kind: 'url', host: hostOf(target), safe: !isLocalAddress(target) };
      }
      return { kind: 'site', path: pathOn(target) };
    case 'WEBAPP': {
      if (ABSOLUTE_ADDRESS.test(target)) {
        // Kept only when Telegram takes it as a Mini App: https, not local.
        return { kind: 'url', host: hostOf(target), safe: target.startsWith('https://') && !isLocalAddress(target) };
      }
      const path = pathOn(target);
      const page = miniAppLandingPage(path);
      return { kind: 'miniApp', path, page, known: ctx.miniAppRoutes === null || ctx.miniAppRoutes.has(page) };
    }
    case 'CALLBACK':
    default:
      return callbackRoute(button.buttonId, ctx);
  }
}

/** Why a button's target cannot be saved: the bot could not open it. */
export type ButtonTargetProblem =
  | 'notAPage'
  | 'badCharacters'
  | 'notAnAddress'
  | 'webAppNeedsHttps'
  | 'upperCaseScheme'
  | 'localAddress'
  /** An http:// address where only https is opened: a screen's link, a notification's. */
  | 'linkNeedsHttps'
  /** Anything but a page where the bot opens a page and nothing else: a notification's Mini App. */
  | 'pageOnly'
  /** A page where only a whole address goes: a notification's link. */
  | 'addressOnly';

/** The main menu's reasons are the same as everyone's. */
export type MenuButtonTargetProblem = ButtonTargetProblem;

/**
 * Where a button's target is read, and so what it may be. Each place the bot
 * opens a target reads it its own way:
 *   • `menuUrl` — a main-menu «Внешняя ссылка»: an `http(s)://` address as
 *     typed, anything else a page of the cabinet website (reiwa `addressOn`);
 *   • `menuWebApp`, `screenWebApp` — a «Mini App» button of the main menu or
 *     of a screen: an `https://` address as typed (`isTelegramSafeButtonUrl`),
 *     anything else a page of the Mini App;
 *   • `screenUrl` — a screen's «Открыть URL»: an `https://` address as typed,
 *     anything else a page of the cabinet website, and an `http://` one left
 *     out (reiwa `buildScreenKeyboard`);
 *   • `notificationWebApp` — a notification's «Mini App»: a page, nothing
 *     else. The bot puts whatever it holds after its own address, so an
 *     address opens `<miniApp>/https://…`, a page the cabinet does not have;
 *   • `notificationUrl` — a notification's «URL»: an `https://` address,
 *     nothing else. The panel sends no other (`validateStoredButton`).
 * `opens` picks the word for an address that is not https.
 */
export const BUTTON_TARGET_RULES = {
  menuUrl: { opens: 'link', address: 'http', page: true },
  menuWebApp: { opens: 'miniApp', address: 'https', page: true },
  screenUrl: { opens: 'link', address: 'https', page: true },
  screenWebApp: { opens: 'miniApp', address: 'https', page: true },
  notificationUrl: { opens: 'link', address: 'https', page: false },
  notificationWebApp: { opens: 'miniApp', address: 'none', page: true },
} as const;

export type ButtonTargetPlace = keyof typeof BUTTON_TARGET_RULES;

/** What a place opens: a link or a Mini App; which addresses as typed; whether a page. */
interface ButtonTargetRule {
  readonly opens: 'link' | 'miniApp';
  readonly address: 'http' | 'https' | 'none';
  readonly page: boolean;
}

/**
 * What is wrong with a button's target where `place` reads it, or `null`
 * when the bot can open it:
 *   • an `http(s)://` address — where the place opens one — that parses, with
 *     a host and no whitespace (`notAnAddress`), whose host is not this machine
 *     (`localAddress`); where only https opens, on https (`webAppNeedsHttps`,
 *     `linkNeedsHttps`) written in lower case, which is all the bot keeps
 *     (`isTelegramSafeButtonUrl` compares case-sensitively; a phone's
 *     auto-capital makes `Https://` — `upperCaseScheme`);
 *   • or a page of the cabinet — where the place opens one — a path the bot
 *     opens as a page (`isPageTarget`: with its single leading `/`, or typed
 *     without it — `renew` opens `/renew`; `notAPage`) that holds no space,
 *     backslash, control or invisible formatting character (`badCharacters`);
 *   • a place that opens only a page refuses anything else (`pageOnly`), one
 *     that opens only an address, a page (`addressOnly`).
 * Empty is fine too: a main-menu button then opens the cabinet's (the Mini
 * App's) home, and elsewhere the map draws the button red. The check the server
 * makes before saving a button's target and the one its form makes, so the
 * operator reads why before saving.
 */
export function buttonTargetProblem(place: ButtonTargetPlace, target: string | null): ButtonTargetProblem | null {
  const rule: ButtonTargetRule = BUTTON_TARGET_RULES[place];
  const trimmed = (target ?? '').trim();
  if (trimmed.length === 0) return null;
  if (ABSOLUTE_ADDRESS.test(trimmed)) {
    if (rule.address === 'none') return 'pageOnly';
    if (!isAddress(trimmed)) return 'notAnAddress';
    if (rule.address === 'https') {
      if (!/^https:\/\//i.test(trimmed)) return rule.opens === 'miniApp' ? 'webAppNeedsHttps' : 'linkNeedsHttps';
      if (!trimmed.startsWith('https://')) return 'upperCaseScheme';
    }
    return isLocalAddress(trimmed) ? 'localAddress' : null;
  }
  if (!rule.page) return 'addressOnly';
  if (!isPageTarget(trimmed)) return rule.address === 'none' ? 'pageOnly' : 'notAPage';
  return hasBadCharacter(trimmed) ? 'badCharacters' : null;
}

/**
 * A target the bot opens as a page of the cabinet: a path with a single
 * leading `/`, or one typed without it, which the bot gives its slash — the
 * main menu (`addressOn`), a notification (`internal-http-listener.ts`) and a
 * screen (`buildScreenKeyboard`) alike, so `renew` opens `/renew` and the map
 * draws it green. Not a page: `//host`, and a target that reads as an address
 * with its scheme or its site left off — its first segment names a scheme, a
 * site or a user (`tg://…`, `mailto:…`, `t.me/channel`, `www.example.com`,
 * `@support`). The bot would open those as pages the cabinet does not have
 * (a screen's `tg://` it leaves out); the reason says to write the address
 * whole.
 */
function isPageTarget(target: string): boolean {
  if (target.startsWith('/')) return !target.startsWith('//');
  const firstSegment = target.split(/[/?#]/, 1)[0];
  return !/[.:@]/.test(firstSegment);
}

/**
 * What is wrong with a main-menu «Внешняя ссылка» or «Mini App» target, or
 * `null` when the bot can open it (`buttonTargetProblem`, `menuUrl` and
 * `menuWebApp`); the other actions carry no address. The check the server makes
 * before saving a main-menu button (`bot-buttons.service.ts`) and the one its
 * forms make.
 */
export function menuButtonTargetProblem(
  actionType: MenuButtonRouting['actionType'],
  actionTarget: string | null,
): MenuButtonTargetProblem | null {
  if (actionType === 'URL') return buttonTargetProblem('menuUrl', actionTarget);
  if (actionType === 'WEBAPP') return buttonTargetProblem('menuWebApp', actionTarget);
  return null;
}

const ABSOLUTE_ADDRESS = /^https?:\/\//i;

/**
 * An address on this machine, which Telegram refuses on a button: its host —
 * not any part of it — is exactly `localhost` or `127.0.0.1`. An address that
 * does not parse is not local. reiwa's copy reads it the same way
 * (`main-keyboard.ts`); the table in `test/bot-map-route-parity.spec.ts` is
 * reiwa's test table too.
 */
export function isLocalAddress(address: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(address).hostname;
  } catch {
    return false;
  }
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/** An address that parses, has a host, and holds no whitespace anywhere. */
function isAddress(address: string): boolean {
  if (/\s/.test(address)) return false;
  try {
    return new URL(address).hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * A character no page's address may hold: a backslash, whitespace (U+FEFF
 * among it, to `\s`), a control character (C0, DEL, C1) or an invisible
 * formatting one — zero-width (U+200B–U+200F, U+2060–U+2064) or a bidi
 * override (U+202A–U+202E) — which makes the address read as something it is
 * not.
 */
function hasBadCharacter(path: string): boolean {
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\' || /\s/.test(char)) return true;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if ((code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e)) return true;
    if (code >= 0x2060 && code <= 0x2064) return true;
  }
  return false;
}

/** A relative target as reiwa's `addressOn` puts it on a base: with its leading slash; none is the root. */
function pathOn(target: string): string {
  if (target.length === 0) return '/';
  return target.startsWith('/') ? target : `/${target}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
