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
}

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

  return Object.keys(filter).length > 0 ? filter : null;
}

/**
 * Build the Prisma `User` where-clause for a broadcast audience. When a
 * structured `filter` is provided it takes precedence; otherwise the legacy
 * `audience` enum preset is used. `now` is injectable for deterministic tests.
 */
export function buildAudienceWhere(
  audience: BroadcastAudience,
  filter: BroadcastAudienceFilter | null,
  now: Date = new Date(),
): Prisma.UserWhereInput {
  if (filter !== null) {
    return buildFromFilter(filter, now);
  }
  return buildFromPreset(audience);
}

function buildFromFilter(filter: BroadcastAudienceFilter, now: Date): Prisma.UserWhereInput {
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
    and.push({ lastSeenAt: { lt: cutoff } });
  }
  if (filter.platforms && filter.platforms.length > 0) {
    and.push({ OR: filter.platforms.map(platformWhere) });
  }
  if (filter.contact && filter.contact.length > 0) {
    and.push({ OR: filter.contact.map(contactWhere) });
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
      return { email: { not: null } };
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
