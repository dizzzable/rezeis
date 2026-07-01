import { Locale, UserRole } from '@prisma/client';

interface InternalUserWebAccountInterface {
  readonly id: string;
  readonly login: string | null;
  readonly loginNormalized: string | null;
  readonly email: string | null;
  readonly emailNormalized: string | null;
  readonly emailVerifiedAt: string | null;
  readonly requiresPasswordChange: boolean;
  readonly linkPromptSnoozeUntil: string | null;
  readonly credentialsBootstrappedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Describes the read-only user session payload exposed to internal user clients.
 *
 * Every Reiwa-facing user — whether the entrypoint was Telegram or the
 * web sign-up form — owns a single canonical identity stored on `id`
 * (CUID). That value is what the rest of Reiwa treats as the immutable
 * `reiwa_id`. `telegramId` is just one of several optional identity
 * fields (see also `email`, `webAccount.login`); a user can exist with
 * `telegramId === null` (web-only sign-up) and still operate the full
 * subscription/payment flow.
 */
export interface InternalUserSessionInterface {
  /**
   * Canonical `reiwa_id` (CUID). Stable across login channels and never
   * changes for the lifetime of the user. Use this to correlate
   * subscriptions, transactions, devices and notifications.
   */
  readonly id: string;
  /**
   * Telegram identity (optional). `null` for users who registered via the
   * web form and have not linked Telegram yet — they can still buy and
   * use subscriptions; the bot only becomes a delivery channel after an
   * explicit `link/telegram/generate` handshake.
   */
  readonly telegramId: string | null;
  readonly username: string | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly role: UserRole;
  readonly language: Locale;
  readonly personalDiscount: number;
  readonly purchaseDiscount: number;
  readonly points: number;
  readonly maxSubscriptions: number;
  readonly isBlocked: boolean;
  readonly isBotBlocked: boolean;
  readonly isRulesAccepted: boolean;
  /**
   * Whether the user has finished/skipped the cabinet onboarding tour.
   * `false` → the SPA auto-starts the tour. Server-persisted so the state
   * follows the user across devices.
   */
  readonly onboardingCompleted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Latest reported cabinet activity (`User.lastSeenAt`), ISO-8601 or `null`.
   * A real activity signal (stamped on each cabinet session) as opposed to
   * `updatedAt`, which only changes when the User row itself is written.
   */
  readonly lastSeenAt: string | null;
  readonly webAccount: InternalUserWebAccountInterface | null;
}
