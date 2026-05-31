import { AuthChallenge, PlanType, Prisma, Subscription, SubscriptionStatus, User, WebAccount } from '@prisma/client';

import { InternalWebAccountEmailVerificationChallengeInterface } from '../interfaces/internal-web-account-email-verification-challenge.interface';
import { InternalUserSessionInterface } from '../interfaces/internal-user-session.interface';
import { PlanCatalogPriceInterface } from '../../plans/interfaces/plan-catalog.interface';
import { InternalUserPlanInterface } from '../interfaces/internal-user-plan.interface';

export type InternalUserRecord = User & { readonly webAccount: WebAccount | null };

export interface MapInternalEmailVerificationChallengeInput {
  readonly webAccount: WebAccount;
  readonly challenge: AuthChallenge;
  readonly email: string;
}

export const INTERNAL_USER_INCLUDE = {
  webAccount: true,
} as const;

/**
 * Folds the internal user record (with optional `webAccount`) into the wire
 * representation consumed by the bot/web edges. Telegram ids are always
 * serialised as decimal strings to avoid precision loss across JSON.
 */
export function mapInternalUserSession(user: InternalUserRecord): InternalUserSessionInterface {
  return {
    id: user.id,
    telegramId: user.telegramId?.toString() ?? null,
    username: user.username,
    name: user.name,
    email: user.email,
    role: user.role,
    language: user.language,
    personalDiscount: user.personalDiscount,
    purchaseDiscount: user.purchaseDiscount,
    points: user.points,
    maxSubscriptions: user.maxSubscriptions,
    isBlocked: user.isBlocked,
    isBotBlocked: user.isBotBlocked,
    isRulesAccepted: user.isRulesAccepted,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    webAccount: user.webAccount === null ? null : {
      id: user.webAccount.id,
      login: user.webAccount.login,
      loginNormalized: user.webAccount.loginNormalized,
      email: user.webAccount.email,
      emailNormalized: user.webAccount.emailNormalized,
      emailVerifiedAt: mapDateValue(user.webAccount.emailVerifiedAt),
      requiresPasswordChange: user.webAccount.requiresPasswordChange,
      linkPromptSnoozeUntil: mapDateValue(user.webAccount.linkPromptSnoozeUntil),
      credentialsBootstrappedAt: mapDateValue(user.webAccount.credentialsBootstrappedAt),
      createdAt: user.webAccount.createdAt.toISOString(),
      updatedAt: user.webAccount.updatedAt.toISOString(),
    },
  };
}

export function mapInternalEmailVerificationChallenge(
  input: MapInternalEmailVerificationChallengeInput,
): InternalWebAccountEmailVerificationChallengeInterface {
  return {
    webAccountId: input.webAccount.id,
    email: input.email,
    challengeExpiresAt: input.challenge.expiresAt.toISOString(),
  };
}

export function mapDateValue(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * Picks the "current" subscription for the user from a flat list. The bot
 * deeplinks need a single subscription to surface — we prefer the active
 * one, then the upcoming one, then the most recently created.
 */
export function selectCurrentSubscription(
  subscriptions: readonly Subscription[],
): Subscription | null {
  if (subscriptions.length === 0) {
    return null;
  }
  const now = new Date();
  const rankedSubscriptions = subscriptions
    .map((subscription) => ({
      subscription,
      rank: getSubscriptionRank(subscription, now),
    }))
    .sort((left, right) => {
      if (left.rank !== right.rank) {
        return left.rank - right.rank;
      }
      return right.subscription.createdAt.getTime() - left.subscription.createdAt.getTime();
    });
  return rankedSubscriptions[0]?.subscription ?? null;
}

function getSubscriptionRank(subscription: Subscription, now: Date): number {
  if (isCurrentSubscription(subscription, now)) {
    return 0;
  }
  if (isUpcomingSubscription(subscription, now)) {
    return 1;
  }
  if (hasFutureExpiry(subscription, now)) {
    return 2;
  }
  return 3;
}

function isCurrentSubscription(subscription: Subscription, now: Date): boolean {
  const isEnabledStatus =
    subscription.status === SubscriptionStatus.ACTIVE ||
    subscription.status === SubscriptionStatus.LIMITED;
  if (!isEnabledStatus) {
    return false;
  }
  if (subscription.startedAt !== null && subscription.startedAt.getTime() > now.getTime()) {
    return false;
  }
  return !isExpiredSubscription(subscription, now);
}

function isUpcomingSubscription(subscription: Subscription, now: Date): boolean {
  if (subscription.startedAt === null) {
    return false;
  }
  return subscription.startedAt.getTime() > now.getTime() && !isExpiredSubscription(subscription, now);
}

function hasFutureExpiry(subscription: Subscription, now: Date): boolean {
  if (subscription.expiresAt === null) {
    return false;
  }
  return subscription.expiresAt.getTime() > now.getTime();
}

function isExpiredSubscription(subscription: Subscription, now: Date): boolean {
  if (subscription.expiresAt === null) {
    return false;
  }
  return subscription.expiresAt.getTime() <= now.getTime();
}

export function mapSubscriptionPlanSnapshot(
  planSnapshot: Prisma.JsonValue,
): { readonly id: string | null; readonly name: string | null; readonly type: PlanType | null } | null {
  if (!isJsonObject(planSnapshot)) {
    return null;
  }
  return {
    id: readOptionalString(planSnapshot, 'id'),
    name: readOptionalString(planSnapshot, 'name'),
    type: readOptionalPlanType(planSnapshot, 'type'),
  };
}

export function collapseLegacyCatalogPrices(
  prices: readonly PlanCatalogPriceInterface[],
): InternalUserPlanInterface['durations'][number]['prices'] {
  const priceByCurrency = new Map<
    InternalUserPlanInterface['durations'][number]['prices'][number]['currency'],
    InternalUserPlanInterface['durations'][number]['prices'][number]
  >();
  for (const price of prices) {
    if (!priceByCurrency.has(price.currency)) {
      priceByCurrency.set(price.currency, {
        currency: price.currency,
        price: price.price,
      });
    }
  }
  return [...priceByCurrency.values()];
}

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(value: Prisma.JsonObject, propertyName: string): string | null {
  const propertyValue = value[propertyName];
  return typeof propertyValue === 'string' ? propertyValue : null;
}

function readOptionalPlanType(value: Prisma.JsonObject, propertyName: string): PlanType | null {
  const propertyValue = value[propertyName];
  if (typeof propertyValue !== 'string') {
    return null;
  }
  return isPlanType(propertyValue) ? propertyValue : null;
}

function isPlanType(value: string): value is PlanType {
  return Object.values(PlanType).includes(value as PlanType);
}
