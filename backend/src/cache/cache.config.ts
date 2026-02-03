/**
 * Cache configuration constants
 * Defines TTL values and prefixes for different data types
 */

/**
 * Cache configuration for different data types
 */
export const CACHE_CONFIG = {
  /** Plans and pricing - cached for long time (rarely changes) */
  plans: {
    ttl: 3600,        // 1 hour
    prefix: 'plans',
  },

  /** User's subscription plans - cached for short time */
  userSubscriptions: {
    ttl: 300,         // 5 minutes
    prefix: 'user:subs',
  },

  /** User's active subscriptions */
  userActiveSubscriptions: {
    ttl: 300,         // 5 minutes
    prefix: 'user:activesubs',
  },

  /** User subscription details */
  subscriptionDetails: {
    ttl: 300,         // 5 minutes
    prefix: 'sub:details',
  },

  /** User profile data */
  userProfile: {
    ttl: 600,         // 10 minutes
    prefix: 'user:profile',
  },

  /** User statistics */
  userStats: {
    ttl: 120,         // 2 minutes
    prefix: 'user:stats',
  },

  /** Referral statistics */
  referralStats: {
    ttl: 600,         // 10 minutes
    prefix: 'ref:stats',
  },

  /** Full referral info */
  fullReferralInfo: {
    ttl: 600,         // 10 minutes
    prefix: 'ref:full',
  },

  /** Referral rules */
  referralRules: {
    ttl: 1800,        // 30 minutes
    prefix: 'ref:rules',
  },

  /** Referral levels */
  referralLevels: {
    ttl: 600,         // 10 minutes
    prefix: 'ref:levels',
  },

  /** Top referrers */
  topReferrers: {
    ttl: 1800,        // 30 minutes
    prefix: 'top:refs',
  },

  /** Partner statistics */
  partnerStats: {
    ttl: 600,         // 10 minutes
    prefix: 'partner:stats',
  },

  /** Full partner stats */
  fullPartnerStats: {
    ttl: 600,         // 10 minutes
    prefix: 'partner:full',
  },

  /** Partner conversion stats */
  conversionStats: {
    ttl: 300,         // 5 minutes
    prefix: 'partner:conv',
  },

  /** Payment history */
  paymentHistory: {
    ttl: 300,         // 5 minutes
    prefix: 'payments',
  },

  /** User notifications */
  notifications: {
    ttl: 120,         // 2 minutes
    prefix: 'notifications',
  },

  /** QR code data */
  qrCode: {
    ttl: 86400,       // 24 hours
    prefix: 'qr',
  },

  /** Rate limiting data */
  rateLimit: {
    ttl: 60,          // 1 minute
    prefix: 'ratelimit',
  },

  /** Session data */
  session: {
    ttl: 604800,      // 7 days
    prefix: 'session',
  },

  /** Global settings */
  settings: {
    ttl: 3600,        // 1 hour
    prefix: 'settings',
  },

  /** Gateway configuration */
  gateways: {
    ttl: 3600,        // 1 hour
    prefix: 'gateways',
  },

  /** Banner data */
  banners: {
    ttl: 1800,        // 30 minutes
    prefix: 'banners',
  },
} as const;

/**
 * Cache namespaces for organization
 */
export const CACHE_NAMESPACES = {
  /** User-related data */
  user: 'user',
  /** Subscription-related data */
  subscription: 'sub',
  /** Referral system data */
  referral: 'ref',
  /** Partner system data */
  partner: 'partner',
  /** Payment data */
  payment: 'payment',
  /** System data */
  system: 'system',
  /** Rate limiting */
  rateLimit: 'ratelimit',
  /** Session data */
  session: 'session',
} as const;

/**
 * Type for cache config keys
 */
export type CacheConfigKey = keyof typeof CACHE_CONFIG;

/**
 * Type for cache namespaces
 */
export type CacheNamespace = keyof typeof CACHE_NAMESPACES;

/**
 * Get cache configuration by key
 * @param key - Cache config key
 * @returns Cache configuration
 */
export function getCacheConfig(key: CacheConfigKey): { ttl: number; prefix: string } {
  return CACHE_CONFIG[key];
}

/**
 * Build cache key with prefix and optional namespace
 * @param prefix - Key prefix
 * @param identifier - Unique identifier
 * @param namespace - Optional namespace
 * @returns Full cache key
 */
export function buildCacheKey(prefix: string, identifier: string, namespace?: string): string {
  if (namespace) {
    return `${namespace}:${prefix}:${identifier}`;
  }
  return `${prefix}:${identifier}`;
}

/**
 * Build pattern for cache key matching
 * @param prefix - Key prefix
 * @param namespace - Optional namespace
 * @returns Pattern for Redis scan
 */
export function buildCachePattern(prefix: string, namespace?: string): string {
  if (namespace) {
    return `${namespace}:${prefix}:*`;
  }
  return `${prefix}:*`;
}
