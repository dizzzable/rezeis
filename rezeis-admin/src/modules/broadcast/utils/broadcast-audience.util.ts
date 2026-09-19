import { BroadcastAudience, Prisma, SubscriptionStatus } from '@prisma/client';

/**
 * Structured, multi-select broadcast audience filter.
 *
 * Every category is optional; a category with values narrows the audience,
 * and categories are combined with AND (a recipient must satisfy each selected
 * category). Within a single category the values are OR'd (e.g. subscription
 * `['ACTIVE','TRIAL']` = active OR trial). When no category is set, the filter
 * is "empty" and the caller falls back to the legacy {@link BroadcastAudience}
 * preset for backward compatibility.
 *
 * The SAME builder feeds BOTH the audience-count preview and the actual
 * recipient resolution, so the number the operator sees always matches who is
 * reached (the two paths used to diverge).
 */
export interface BroadcastAudienceFilter {
  /** Subscription lifecycle buckets (any-of). */
  readonly subscription?: ReadonlyArray<SubscriptionAudienceBucket>;
  /** Match a subscription whose plan snapshot id is one of these (any-of). */
  readonly planIds?: readonly string[];
  /** Only users last active strictly MORE than N days ago (lapsed users). */
  readonly inactiveDays?: number;
  /** Last-seen surface / reachability platform (any-of). */
  readonly platforms?: ReadonlyArray<AudiencePlatform>;
  /** Contactability channels the user has (any-of). */
  readonly contact?: ReadonlyArray<AudienceContact>;
  /**
   * «Подключение VPN»: only people VERIFIED not connected in one bucket —
   * resolved by `ConnectAudienceService` into a list of user ids, so only the
   * ASYNC {@link resolveAudienceWhere} can apply it. The synchronous builder
   * narrows it to nobody (see there).
   */
  readonly connect?: BroadcastConnectFilter | UnreadableConnectFilter;
}

/** «Подключение VPN» as a broadcast stores it (`audienceFilter.connect`). */
export interface BroadcastConnectFilter {
  /** «Оплатил и не подключился» or «Пробный период или подарок — не подключился». Never both. */
  readonly bucket: 'paid' | 'trial';
  /** «За последние, дней», 1–30. */
  readonly withinDays: number;
  /** «Не слать тем, кому уже помогли». */
  readonly excludeHelped: boolean;
}

/**
 * A `connect` block this image cannot read: a newer panel's shape after a
 * rollback, or a damaged row. Dropping it the way unknown values are dropped
 * everywhere else would WIDEN the audience — to the other chips, or to the
 * preset — so it is kept, and it matches nobody.
 */
export interface UnreadableConnectFilter {
  readonly unreadable: true;
}

export const CONNECT_FILTER_MIN_DAYS = 1;
export const CONNECT_FILTER_MAX_DAYS = 30;
export const CONNECT_FILTER_DEFAULT_DAYS = 7;

export function isUnreadableConnectFilter(
  connect: BroadcastConnectFilter | UnreadableConnectFilter,
): connect is UnreadableConnectFilter {
  return 'unreadable' in connect;
}

/**
 * Where «Подключение VPN» gets its people from: `ConnectAudienceService`, or
 * a list already resolved (staging resolves before its claim, to refuse
 * cleanly, and hands the same list on).
 */
export type ConnectUserIdsSource = (connect: BroadcastConnectFilter) => Promise<readonly string[]>;

export type SubscriptionAudienceBucket = 'ACTIVE' | 'EXPIRED' | 'TRIAL' | 'LIMITED' | 'NONE';
export type AudiencePlatform = 'telegram' | 'miniapp' | 'web';
export type AudienceContact = 'hasTelegram' | 'hasEmail' | 'hasWebPush';

const SUBSCRIPTION_BUCKETS: ReadonlySet<string> = new Set([
  'ACTIVE',
  'EXPIRED',
  'TRIAL',
  'LIMITED',
  'NONE',
]);
const PLATFORMS: ReadonlySet<string> = new Set(['telegram', 'miniapp', 'web']);
const CONTACTS: ReadonlySet<string> = new Set(['hasTelegram', 'hasEmail', 'hasWebPush']);

/** Base predicate applied to EVERY audience: never message a blocked user. */
const BASE_WHERE: Prisma.UserWhereInput = { isBlocked: false };

/**
 * Normalise a raw (possibly-untyped JSON) audience filter into a clean
 * {@link BroadcastAudienceFilter}, dropping unknown values. Returns `null`
 * when nothing usable remains (caller falls back to the enum preset).
 */
export function normalizeAudienceFilter(raw: unknown): BroadcastAudienceFilter | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const filter: {
    subscription?: SubscriptionAudienceBucket[];
    planIds?: string[];
    inactiveDays?: number;
    platforms?: AudiencePlatform[];
    contact?: AudienceContact[];
    connect?: BroadcastConnectFilter | UnreadableConnectFilter;
  } = {};

  const subscription = readStringArray(record.subscription).filter((v): v is SubscriptionAudienceBucket =>
    SUBSCRIPTION_BUCKETS.has(v),
  );
  if (subscription.length > 0) filter.subscription = subscription;

  const planIds = readStringArray(record.planIds);
  if (planIds.length > 0) filter.planIds = planIds;

  const inactiveDays = record.inactiveDays;
  if (typeof inactiveDays === 'number' && Number.isFinite(inactiveDays) && inactiveDays > 0) {
    filter.inactiveDays = Math.floor(inactiveDays);
  }

  const platforms = readStringArray(record.platforms).filter((v): v is AudiencePlatform =>
    PLATFORMS.has(v),
  );
  if (platforms.length > 0) filter.platforms = platforms;

  const contact = readStringArray(record.contact).filter((v): v is AudienceContact =>
    CONTACTS.has(v),
  );
  if (contact.length > 0) filter.contact = contact;

  const connect = readConnectFilter(record.connect);
  if (connect !== undefined) filter.connect = connect;

  return Object.keys(filter).length > 0 ? filter : null;
}

const CONNECT_KEYS: ReadonlySet<string> = new Set(['bucket', 'withinDays', 'excludeHelped']);
const UNREADABLE_CONNECT: UnreadableConnectFilter = { unreadable: true };

/**
 * `connect` as stored. Absent or `null` is "no such filter". A readable one is
 * normalised (days clamped into 1–30 — narrowing, never widening — and
 * `excludeHelped` on unless it is literally `false`). Anything else, including
 * a key this image does not know, is {@link UnreadableConnectFilter}.
 */
function readConnectFilter(value: unknown): BroadcastConnectFilter | UnreadableConnectFilter | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return UNREADABLE_CONNECT;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !CONNECT_KEYS.has(key))) return UNREADABLE_CONNECT;
  const bucket = record.bucket;
  if (bucket !== 'paid' && bucket !== 'trial') return UNREADABLE_CONNECT;
  const days = record.withinDays;
  let withinDays: number;
  if (days === undefined) {
    withinDays = CONNECT_FILTER_DEFAULT_DAYS;
  } else if (typeof days === 'number' && Number.isFinite(days)) {
    withinDays = Math.min(CONNECT_FILTER_MAX_DAYS, Math.max(CONNECT_FILTER_MIN_DAYS, Math.floor(days)));
  } else {
    return UNREADABLE_CONNECT;
  }
  return { bucket, withinDays, excludeHelped: record.excludeHelped !== false };
}

/**
 * Build the Prisma `User` where-clause for a broadcast audience. When a
 * structured `filter` is provided it takes precedence; otherwise the legacy
 * `audience` enum preset is used. `now` is injectable for deterministic tests.
 *
 * SYNCHRONOUS, so it cannot resolve «Подключение VPN» (`filter.connect`): that
 * part narrows to NOBODY here. The broadcast preview and staging use
 * {@link resolveAudienceWhere}; quests and contests, which share this builder,
 * never store a `connect` (their DTO refuses the key) — and should one appear
 * anyway, it must not become "everyone the other chips allow".
 */
export function buildAudienceWhere(
  audience: BroadcastAudience,
  filter: BroadcastAudienceFilter | null,
  now: Date = new Date(),
): Prisma.UserWhereInput {
  if (filter !== null) {
    return buildFromFilter(filter, now, []);
  }
  return buildFromPreset(audience);
}

/**
 * {@link buildAudienceWhere} with «Подключение VPN» resolved: its people
 * become one more AND-ed condition, `{ id: { in: [...] } }`, next to the other
 * chips. `connectUserIds` is asked only when the filter carries a readable
 * `connect`; an unreadable one narrows to nobody without asking. The broadcast
 * preview (`countAudience`) and staging (`resolveRecipients`) both build their
 * where here, so the number shown and the people reached cannot diverge.
 */
export async function resolveAudienceWhere(
  audience: BroadcastAudience,
  filter: BroadcastAudienceFilter | null,
  connectUserIds: ConnectUserIdsSource,
  now: Date = new Date(),
): Promise<Prisma.UserWhereInput> {
  if (filter === null) {
    return buildFromPreset(audience);
  }
  const connect = filter.connect;
  const ids =
    connect === undefined || isUnreadableConnectFilter(connect) ? [] : await connectUserIds(connect);
  return buildFromFilter(filter, now, ids);
}

function buildFromFilter(
  filter: BroadcastAudienceFilter,
  now: Date,
  connectUserIds: readonly string[],
): Prisma.UserWhereInput {
  const and: Prisma.UserWhereInput[] = [];

  if (filter.subscription && filter.subscription.length > 0) {
    and.push({ OR: filter.subscription.map(subscriptionBucketWhere) });
  }
  if (filter.planIds && filter.planIds.length > 0) {
    and.push({
      subscriptions: {
        some: {
          OR: filter.planIds.map((id) => ({
            planSnapshot: { path: ['id'], equals: id },
          })),
        },
      },
    });
  }
  if (typeof filter.inactiveDays === 'number' && filter.inactiveDays > 0) {
    const cutoff = new Date(now.getTime() - filter.inactiveDays * 86_400_000);
    // `lastSeenAt` is nullable, and SQL `<` never matches NULL — so "inactive
    // for 60+ days" silently skipped everyone who signed up and never came
    // back. That is the MOST lapsed segment, and a win-back campaign was
    // missing exactly the people it was for, with a preview count that agreed.
    and.push({ OR: [{ lastSeenAt: { lt: cutoff } }, { lastSeenAt: null }] });
  }
  if (filter.platforms && filter.platforms.length > 0) {
    and.push({ OR: filter.platforms.map(platformWhere) });
  }
  if (filter.contact && filter.contact.length > 0) {
    and.push({ OR: filter.contact.map(contactWhere) });
  }
  if (filter.connect !== undefined) {
    // Resolved or not, present means NARROWED: an empty list is nobody.
    and.push({ id: { in: [...connectUserIds] } });
  }

  if (and.length === 0) {
    return { ...BASE_WHERE };
  }
  return { ...BASE_WHERE, AND: and };
}

function subscriptionBucketWhere(bucket: SubscriptionAudienceBucket): Prisma.UserWhereInput {
  switch (bucket) {
    case 'ACTIVE':
      return { subscriptions: { some: { status: SubscriptionStatus.ACTIVE } } };
    case 'LIMITED':
      return { subscriptions: { some: { status: SubscriptionStatus.LIMITED } } };
    case 'TRIAL':
      return {
        subscriptions: { some: { isTrial: true, status: SubscriptionStatus.ACTIVE } },
      };
    case 'EXPIRED':
      // Expired AND not currently active (an expired sub alongside an active
      // one shouldn't count as "lapsed").
      return {
        subscriptions: { some: { status: SubscriptionStatus.EXPIRED } },
        NOT: { subscriptions: { some: { status: SubscriptionStatus.ACTIVE } } },
      };
    case 'NONE':
      return { subscriptions: { none: {} } };
  }
}

function platformWhere(platform: AudiencePlatform): Prisma.UserWhereInput {
  switch (platform) {
    case 'telegram':
      return { telegramId: { not: null } };
    case 'miniapp':
      return { lastSurface: 'tma' };
    case 'web':
      return { lastSurface: { in: ['pwa', 'browser'] } };
  }
}

function contactWhere(contact: AudienceContact): Prisma.UserWhereInput {
  switch (contact) {
    case 'hasTelegram':
      return { telegramId: { not: null } };
    case 'hasEmail':
      // The address may live on either row. Delivery resolves
      // `User.email ?? WebAccount.email`, and every OAuth sign-up deliberately
      // leaves `User.email` unset while AltShop imports write to the web
      // account only — so this chip, meant to NARROW a send to mailable users,
      // was dropping most of them from the broadcast entirely: not just from
      // the email leg but from Telegram and the cabinet feed too.
      return {
        OR: [{ email: { not: null } }, { webAccount: { email: { not: null } } }],
      };
    case 'hasWebPush':
      return { webPushSubscriptions: { some: {} } };
  }
}

function buildFromPreset(audience: BroadcastAudience): Prisma.UserWhereInput {
  switch (audience) {
    case BroadcastAudience.ACTIVE_SUBSCRIBERS:
      return { ...BASE_WHERE, subscriptions: { some: { status: SubscriptionStatus.ACTIVE } } };
    case BroadcastAudience.EXPIRED:
      return {
        ...BASE_WHERE,
        subscriptions: { some: { status: SubscriptionStatus.EXPIRED } },
        NOT: { subscriptions: { some: { status: SubscriptionStatus.ACTIVE } } },
      };
    case BroadcastAudience.TRIAL:
      return {
        ...BASE_WHERE,
        subscriptions: { some: { isTrial: true, status: SubscriptionStatus.ACTIVE } },
      };
    case BroadcastAudience.UNSUBSCRIBED:
      return { ...BASE_WHERE, subscriptions: { none: {} } };
    case BroadcastAudience.ALL:
    default:
      return { ...BASE_WHERE };
  }
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}
