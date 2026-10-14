/**
 * What a Reiwa cabinet can do, as this panel knows it (pair reliability,
 * 26.09.2026).
 *
 * The panel and the cabinet ship as two images, updated in either order. A
 * behaviour where one side needs the other side's new code gets ONE id here and
 * the same id in the cabinet's own registry (reiwa `src/core/capabilities.ts`),
 * in the same pair of releases. The cabinet declares the ids it implements on
 * every internal call (`x-reiwa-capabilities`, `reiwa-client-headers.ts`); the
 * panel turns a behaviour on only through `CabinetView.can(id)`, and falls back
 * to the previous release's behaviour, never to "on".
 *
 * ── A cabinet that says nothing ───────────────────────────────────────────
 *
 * Cabinets up to 0.9.7.53 send no header. They are placed by the evidence they
 * leave (`reiwa-peer-registry.service.ts`): a settings poll without the header
 * is 0.9.7.53 (the poll exists from 0.9.7.53 and every later cabinet declares),
 * a version heartbeat names its exact version, and no evidence at all is the
 * supported floor, {@link CABINET_FLOOR_VERSION}. Each version then stands for
 * the ids it had: {@link impliedCapabilities}. That table is FROZEN at
 * {@link IMPLIED_CEILING_VERSION}: an id introduced later is never implied by
 * any version, it waits for a cabinet that declares it.
 *
 * ── The rules for an id ───────────────────────────────────────────────────
 *
 *  - The prefix is the surface that implements it: `web` (the cabinet's SPA,
 *    served and declared by reiwa-api), `api` (reiwa-api itself), `bot`.
 *    `panel.*` ids are this panel's own, announced the other way
 *    (`panel-capabilities.ts`).
 *  - The meaning of an id never changes; a changed meaning is a new id with
 *    `.v2`.
 *  - An id leaves this table only when the floor passes its `since`, and the
 *    gate code leaves with it.
 *  - A `gate` names the files that check it (`gatedIn`), and
 *    `test/cabinet-capabilities.registry.spec.ts` holds each of them to a
 *    `.can(CABINET_CAPABILITY.<key>)`: a gate nobody checks, or a check of an
 *    id nobody registered, is red.
 *
 * `operatorText` is what «WEB Reiwa» and the card «🧩 Кабинет старше панели»
 * say about a cabinet that lacks the id, and what the release notes' order box
 * is written from. Russian, lower-case, no final full stop: it is one item of
 * a list («До его обновления: • …; • …»).
 */

/** The cabinet processes that call this panel, as `x-reiwa-client` names them. */
export const REIWA_PROCESS_SURFACES = ['api', 'bot', 'worker'] as const;
export type ReiwaProcessSurface = (typeof REIWA_PROCESS_SURFACES)[number];

export function isReiwaProcessSurface(value: unknown): value is ReiwaProcessSurface {
  return typeof value === 'string' && (REIWA_PROCESS_SURFACES as readonly string[]).includes(value);
}

/** Where a capability is implemented: the prefix of its id. */
export type CabinetCapabilitySurface = 'web' | 'api' | 'bot';

/**
 * Which capability surfaces each process speaks for. reiwa-api serves the web
 * SPA, so it declares `web.*` beside its own `api.*`; the bot declares `bot.*`;
 * the optional worker declares nothing. A process's declaration is read only
 * for the surfaces it hosts — an api process cannot vouch for the bot.
 */
export const HOSTED_CAPABILITY_SURFACES: Readonly<Record<ReiwaProcessSurface, readonly CabinetCapabilitySurface[]>> = {
  api: ['web', 'api'],
  bot: ['bot'],
  worker: [],
};

export const CABINET_CAPABILITY = {
  /** «Докупка трафика до сброса» is shown with its reset end, in the panel's zone, with the <24 h warning. */
  addonResetEnd: 'web.addon-reset-end',
  /**
   * Antilopay's SBP autopay with a delayed first charge: the consent says that
   * nothing is charged now, that access for the delay starts at once and when the
   * first charge comes, and sends back the delay it showed.
   */
  autopayFirstChargeDelay: 'web.autopay-first-charge-delay',
  /** A subscription with no end date: no dead «Продлить», no «Улучшить» that ends in an error. */
  lifetimeSubscription: 'web.lifetime-subscription',
  /** The bell's «Докупка не применена» opens «Поддержка». */
  bellAddonNotApplied: 'web.bell-addon-not-applied',
  /** Dates are shown in the operator's «Часовой пояс», not by the phone's clock. */
  panelTimezoneDates: 'web.panel-timezone-dates',
  /** Refuses one bad appearance field at a time and reports which (`POST /api/internal/branding/delivery`). */
  appearanceReport: 'api.appearance-report',
  /** reiwa-api polls the settings versions (`POST /api/internal/config-versions`). */
  apiConfigVersionPoll: 'api.config-version-poll',
  /** reiwa-bot polls the settings versions. */
  botConfigVersionPoll: 'bot.config-version-poll',
  /** A press on a button the bot no longer knows answers «Меню обновилось». */
  staleButtonMenu: 'bot.stale-button-menu',
} as const;

export type CabinetCapabilityKey = keyof typeof CABINET_CAPABILITY;
export type CabinetCapabilityId = (typeof CABINET_CAPABILITY)[CabinetCapabilityKey];

export interface CabinetCapabilityRow {
  readonly id: CabinetCapabilityId;
  readonly surface: CabinetCapabilitySurface;
  /** The first cabinet release that implements it. */
  readonly since: string;
  /**
   * `gate`: the panel withholds something from a cabinet without it (money or
   * a broken flow). `degraded`: nothing is withheld; the operator is told what
   * does not work until the cabinet is updated.
   */
  readonly kind: 'gate' | 'degraded';
  /** One list item, in Russian, for «WEB Reiwa», the card and the release notes. */
  readonly operatorText: string;
  /** The same item for «WEB Reiwa» in English; the card is Russian only. */
  readonly operatorTextEn: string;
  /** `gate` only: the files that check it with `.can(CABINET_CAPABILITY.<key>)`. */
  readonly gatedIn?: readonly string[];
}

export const CABINET_CAPABILITY_REGISTRY: readonly CabinetCapabilityRow[] = [
  {
    id: CABINET_CAPABILITY.addonResetEnd,
    surface: 'web',
    since: '0.9.7.53',
    kind: 'gate',
    // Reiwa 0.9.7.52 and older show it as «Действует до 01.10.26»: no word of
    // the reset, by the phone's clock, and no warning of a reset less than a
    // day away (reiwa `web/src/features/addons/add-on-end.ts`).
    operatorText: 'докупка трафика «до сброса» в кабинете не продаётся',
    operatorTextEn: 'traffic top-ups “until the reset” are not sold in the cabinet',
    gatedIn: [
      'src/modules/add-ons/services/add-on-eligibility.service.ts',
      'src/modules/payments/services/addon-purchase.service.ts',
    ],
  },
  {
    id: CABINET_CAPABILITY.autopayFirstChargeDelay,
    surface: 'web',
    since: '0.9.7.56',
    kind: 'gate',
    // Reiwa 0.9.7.55 and older would show the autopay consent of a delayed sign-up
    // as «спишется сразу»: the customer would agree to a charge that does not
    // come, and be given access for nothing they were told about
    // (reiwa `web/src/lib/autopay-delay.ts`).
    operatorText:
      'отсрочка первого списания по СБП в Antilopay не предлагается: старый кабинет написал бы клиенту «спишется сразу», и списание остаётся сразу',
    operatorTextEn:
      'the delay of the first SBP charge at Antilopay is not offered: an older cabinet would tell the customer “charged at once”, so the charge stays at once',
    gatedIn: ['src/modules/payments/utils/antilopay-delay-policy.util.ts'],
  },
  {
    id: CABINET_CAPABILITY.lifetimeSubscription,
    surface: 'web',
    since: '0.9.7.53',
    kind: 'degraded',
    operatorText:
      'у бессрочной подписки «Продлить» ничего не делает и не объясняет почему, а «Улучшить» заканчивается ошибкой (деньги не списываются)',
    operatorTextEn:
      'on a subscription with no end date, “Renew” does nothing and does not say why, and “Upgrade” ends in an error (nothing is charged)',
  },
  {
    id: CABINET_CAPABILITY.bellAddonNotApplied,
    surface: 'web',
    since: '0.9.7.53',
    kind: 'degraded',
    operatorText: 'уведомление «Докупка не применена» в колокольчике открывает «Дополнительные опции», а не «Поддержку»',
    operatorTextEn: 'the bell’s “Add-on not applied” opens “Add-ons” instead of “Support”',
  },
  {
    id: CABINET_CAPABILITY.panelTimezoneDates,
    surface: 'web',
    since: '0.9.7.53',
    kind: 'degraded',
    operatorText:
      'даты в кабинете идут по часам телефона, а не в часовом поясе из «Платформа» → «Настройки платформы» → «Часовой пояс»',
    operatorTextEn:
      'dates in the cabinet follow the phone’s clock, not the time zone set in “Platform” → “Platform Settings” → “Time zone”',
  },
  {
    id: CABINET_CAPABILITY.appearanceReport,
    surface: 'api',
    since: '0.9.7.53',
    kind: 'degraded',
    operatorText:
      'если одно поле оформления кабинету не подходит, он не принимает всё оформление, и панель не может показать, какое поле виновато',
    operatorTextEn:
      'if one appearance field does not suit the cabinet, it rejects the whole appearance, and the panel cannot show which field is at fault',
  },
  {
    id: CABINET_CAPABILITY.apiConfigVersionPoll,
    surface: 'api',
    since: '0.9.7.53',
    kind: 'degraded',
    operatorText:
      'сайт не сверяет версии настроек с панелью: если сигнал об изменении потеряется, сайт его не заметит (панель пришлёт карточку «Изменение настроек не дошло до кабинета»)',
    operatorTextEn:
      'the site does not compare settings versions with the panel: if a change signal is lost, the site will not notice (the panel sends the card «Изменение настроек не дошло до кабинета»)',
  },
  {
    id: CABINET_CAPABILITY.botConfigVersionPoll,
    surface: 'bot',
    since: '0.9.7.53',
    kind: 'degraded',
    operatorText:
      'бот не сверяет версии настроек с панелью: если сигнал об изменении потеряется, бот его не заметит (панель пришлёт карточку «Изменение настроек не дошло до кабинета»)',
    operatorTextEn:
      'the bot does not compare settings versions with the panel: if a change signal is lost, the bot will not notice (the panel sends the card «Изменение настроек не дошло до кабинета»)',
  },
  {
    id: CABINET_CAPABILITY.staleButtonMenu,
    surface: 'bot',
    since: '0.9.7.53',
    kind: 'degraded',
    operatorText:
      'на нажатие устаревшей кнопки бот не отвечает «Меню обновилось», как рисует «Карта бота», а молчит или пишет, что экран не найден',
    operatorTextEn:
      'a press on an outdated button is not answered with “Menu updated” as “Bot map” shows: the bot stays silent or says the screen was not found',
  },
];

/** The oldest cabinet this panel is built for, and what a cabinet that left no evidence is taken to be. */
export const CABINET_FLOOR_VERSION = '0.9.7.52';

/**
 * The last version whose capabilities can be IMPLIED. Every cabinet after it
 * declares what it can do, so an id introduced later is never inferred from a
 * version number — not even from a heartbeat that claims a newer one.
 */
export const IMPLIED_CEILING_VERSION = '0.9.7.53';

/** A settings poll without `x-reiwa-client`: the poll exists from 0.9.7.53, and every later cabinet declares. */
export const SILENT_POLL_VERSION = '0.9.7.53';

const REGISTERED_IDS: ReadonlySet<string> = new Set(CABINET_CAPABILITY_REGISTRY.map((row) => row.id));

export function isCabinetCapabilityId(value: string): value is CabinetCapabilityId {
  return REGISTERED_IDS.has(value);
}

/** The registry rows a process speaks for, in registry order. */
export function capabilityRowsHostedBy(surface: ReiwaProcessSurface): readonly CabinetCapabilityRow[] {
  const hosted = HOSTED_CAPABILITY_SURFACES[surface];
  return CABINET_CAPABILITY_REGISTRY.filter((row) => hosted.includes(row.surface));
}

/** Whether a process speaks for this capability (an api process for `web.*` and `api.*`, …). */
export function isHostedBy(surface: ReiwaProcessSurface, id: CabinetCapabilityId): boolean {
  const row = CABINET_CAPABILITY_REGISTRY.find((candidate) => candidate.id === id);
  return row !== undefined && HOSTED_CAPABILITY_SURFACES[surface].includes(row.surface);
}

/**
 * Orders two cabinet versions — `MAJOR.MINOR.PATCH[.BUILD][-PRE]`, a missing
 * part is 0, a pre-release sorts below its release.
 *
 * The same order as `compareSemver` in `update-checker.service.ts`, kept here
 * rather than imported: that file injects `ReiwaPeerRegistry`, and a registry
 * that imported it back would close a require cycle through Nest's decorator
 * metadata — whichever file loads first would see the other's class as
 * `undefined`. `test/cabinet-capabilities.registry.spec.ts` holds the two
 * equal on a table of pairs.
 */
export function compareCabinetVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 4; index += 1) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.pre === '' && right.pre !== '') return 1;
  if (left.pre !== '' && right.pre === '') return -1;
  return left.pre.localeCompare(right.pre);
}

function parseVersion(value: string): { readonly parts: readonly number[]; readonly pre: string } {
  const trimmed = value.trim().replace(/^v/i, '');
  const [main, pre = ''] = trimmed.split('-', 2);
  const parts = (main ?? '').split('.').map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return { parts, pre };
}

/**
 * The capabilities a cabinet of `version` has, when it does not say: the ids
 * whose `since` it has reached, never past {@link IMPLIED_CEILING_VERSION}.
 * All surfaces; a caller restricts them to what a process hosts.
 */
export function impliedCapabilities(version: string): readonly CabinetCapabilityId[] {
  return CABINET_CAPABILITY_REGISTRY.filter(
    (row) =>
      compareCabinetVersions(row.since, version) <= 0 &&
      compareCabinetVersions(row.since, IMPLIED_CEILING_VERSION) <= 0,
  ).map((row) => row.id);
}

/**
 * What one caller, or one surface, can do — the answer every gate asks.
 *
 * Built by `ReiwaPeerRegistry` from the caller's own headers (a money gate:
 * `viewOfRequest`) or from what the panel recorded about a surface (behaviour
 * the panel starts itself: `view`). `basis` says which, for a log line.
 */
export class CabinetView {
  private readonly ids: ReadonlySet<CabinetCapabilityId>;

  private constructor(ids: Iterable<string>, public readonly basis: string) {
    const kept = new Set<CabinetCapabilityId>();
    for (const id of ids) if (isCabinetCapabilityId(id)) kept.add(id);
    this.ids = kept;
  }

  /** The registered ids among `ids`; anything else is dropped. */
  public static of(ids: Iterable<string>, basis: string): CabinetView {
    return new CabinetView(ids, basis);
  }

  /** What a cabinet that left no evidence is taken to have: {@link CABINET_FLOOR_VERSION}'s implied set. */
  public static floor(basis = `no evidence: the floor, Reiwa ${CABINET_FLOOR_VERSION}`): CabinetView {
    return new CabinetView(impliedCapabilities(CABINET_FLOOR_VERSION), basis);
  }

  /**
   * Every capability this panel knows. For specs, and for a caller that is not
   * a cabinet at all — never as a default for one that did not say.
   */
  public static all(): CabinetView {
    return new CabinetView(REGISTERED_IDS, 'every registered capability');
  }

  public can(id: CabinetCapabilityId): boolean {
    return this.ids.has(id);
  }

  /** The ids it has, in registry order. */
  public get capabilities(): readonly CabinetCapabilityId[] {
    return CABINET_CAPABILITY_REGISTRY.filter((row) => this.ids.has(row.id)).map((row) => row.id);
  }
}
