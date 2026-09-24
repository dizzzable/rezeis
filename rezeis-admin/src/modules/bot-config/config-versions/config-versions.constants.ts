import type { ReiwaRelayEvent } from '../../notifications/reiwa-relay.constants';

/**
 * The settings groups the cabinet copies, named by the internal route each copy
 * comes from. The cabinet names them the same way
 * (`reiwa/src/infrastructure/config-versions/config-version.ts`); a key only one
 * side knows is skipped by the other, so adding a group is backwards-compatible
 * in both directions.
 */
export const CONFIG_VERSION_KEY = {
  /** `GET /api/internal/branding/public-config`. */
  publicConfig: 'publicConfig',
  /** `GET /api/internal/bot-config`. */
  botConfig: 'botConfig',
  /** `GET /api/internal/landing-config/effective`. */
  landing: 'landing',
  /** `GET /api/internal/connect-page/effective`. */
  connectPage: 'connectPage',
  /** `GET /api/internal/settings/platform-policy`. */
  platformPolicy: 'platformPolicy',
  /** `GET /api/internal/legal-documents?locale=ru`. */
  legalDocumentsRu: 'legalDocuments.ru',
  /** `GET /api/internal/legal-documents?locale=en`. */
  legalDocumentsEn: 'legalDocuments.en',
  /** `GET /api/internal/custom-emoji/packs`. */
  customEmojiPacks: 'customEmojiPacks',
  /** `GET /api/internal/support/guest/config`. */
  guestSupport: 'guestSupport',
} as const;

export type ConfigVersionKey = (typeof CONFIG_VERSION_KEY)[keyof typeof CONFIG_VERSION_KEY];

export const CONFIG_VERSION_KEYS: readonly ConfigVersionKey[] = Object.values(CONFIG_VERSION_KEY);

export function isConfigVersionKey(value: unknown): value is ConfigVersionKey {
  return typeof value === 'string' && (CONFIG_VERSION_KEYS as readonly string[]).includes(value);
}

/** The cabinet's processes that poll, each holding its own copies. */
export const CONFIG_VERSION_CONSUMERS = ['api', 'bot'] as const;

export type ConfigVersionConsumer = (typeof CONFIG_VERSION_CONSUMERS)[number];

export function isConfigVersionConsumer(value: unknown): value is ConfigVersionConsumer {
  return typeof value === 'string' && (CONFIG_VERSION_CONSUMERS as readonly string[]).includes(value);
}

/** The five relay events that are cache hints — "the copy of these groups is stale". */
export type ConfigHintEvent = Extract<
  ReiwaRelayEvent,
  | 'reiwa.bot.invalidate'
  | 'reiwa.platform.policy_invalidated'
  | 'reiwa.branding.invalidate'
  | 'reiwa.landing.invalidate'
  | 'reiwa.connect-page.invalidate'
>;

/**
 * Which groups a hint is about. Wider is harmless — a group the save did not
 * touch has the same version before and after, so the check finds it
 * delivered — and narrower is not, so the policy hint names everything the
 * cabinet drops on it: the policy, the legal documents (their edits ride the
 * same event), and the public config (default currency and project name live
 * in both).
 */
export const HINT_GROUPS: Readonly<Record<ConfigHintEvent, readonly ConfigVersionKey[]>> = {
  'reiwa.bot.invalidate': [CONFIG_VERSION_KEY.botConfig],
  'reiwa.platform.policy_invalidated': [
    CONFIG_VERSION_KEY.platformPolicy,
    CONFIG_VERSION_KEY.legalDocumentsRu,
    CONFIG_VERSION_KEY.legalDocumentsEn,
    CONFIG_VERSION_KEY.publicConfig,
  ],
  'reiwa.branding.invalidate': [CONFIG_VERSION_KEY.publicConfig, CONFIG_VERSION_KEY.customEmojiPacks],
  'reiwa.landing.invalidate': [CONFIG_VERSION_KEY.landing],
  'reiwa.connect-page.invalidate': [CONFIG_VERSION_KEY.connectPage],
};

export function isConfigHintEvent(event: string): event is ConfigHintEvent {
  return Object.prototype.hasOwnProperty.call(HINT_GROUPS, event);
}

/**
 * How long one process keeps the versions it computed. The cabinet polls from
 * two processes every ~20 s, so without it every poll built nine payloads; a
 * hint busts it in the process that sent the hint (`ConfigVersionsService.bust`).
 */
export const CONFIG_VERSIONS_CACHE_TTL_MS = 15_000;

/** When after a save its delivery is checked — the owner's rule: two minutes. */
export const CONFIG_DELIVERY_CHECK_DELAY_MS = 2 * 60_000;

/**
 * A process whose last poll is older than this at check time is not checking
 * in: it polls every ~20 s, so this is four polls missed.
 */
export const CONFIG_DELIVERY_REPORT_FRESH_MS = 90_000;

/** How long reports, save marks and hint outcomes are kept in Redis. */
export const CONFIG_DELIVERY_STATE_TTL_SECONDS = 60 * 60;

export const CONFIG_DELIVERY_CHECK_QUEUE = 'config-delivery-check';
export const CONFIG_DELIVERY_CHECK_JOB = 'config.delivery-check';

/** Versioned, so a later change of meaning does not read this one's records. */
const STATE_PREFIX = 'rezeis:config-delivery:v1';

/** What one cabinet process said it holds, at its last poll. */
export function configReportKey(consumer: ConfigVersionConsumer): string {
  return `${STATE_PREFIX}:report:${consumer}`;
}

/** When the latest save of a group was hinted. */
export function configLatestSaveKey(group: ConfigVersionKey): string {
  return `${STATE_PREFIX}:latest-save:${group}`;
}

/** The relay's final word on the latest hint of this kind. */
export function configHintOutcomeKey(event: ConfigHintEvent): string {
  return `${STATE_PREFIX}:hint:${event}`;
}

/**
 * The delivery tracker, reached by a token: `ReiwaCacheInvalidatorService` is
 * declared in seven modules and the relay processor in its own, and none of
 * them may import the module that holds the tracker without closing a cycle
 * (`undelivered-record.ts` tells the same story for the recorder). The module
 * that provides it is global; the consumers take it `@Optional()`, so a module
 * built without it — a spec — keeps the behaviour it had.
 */
export const CONFIG_DELIVERY_TRACKER = Symbol('CONFIG_DELIVERY_TRACKER');

export interface ConfigDeliveryTracker {
  /**
   * A hint left for the cabinet — queued, or sent directly. The process's
   * versions are recomputed from here on, and the save's delivery is checked
   * in two minutes. Never throws.
   */
  hintSent(event: ConfigHintEvent, reason: string): Promise<void>;
  /**
   * What the relay made of a hint in the end: delivered, or the status it gave
   * up on. Evidence for the check when the cabinet does not report what it
   * holds. Never throws.
   */
  hintSettled(event: ConfigHintEvent, delivered: boolean, status: string): Promise<void>;
}

/** Payload of a delivery-check job. Must stay JSON-serialisable. */
export interface ConfigDeliveryCheckJobData {
  readonly event: ConfigHintEvent;
  readonly groups: readonly ConfigVersionKey[];
  /** Epoch ms the hint was sent. */
  readonly savedAt: number;
  readonly reason: string;
}
