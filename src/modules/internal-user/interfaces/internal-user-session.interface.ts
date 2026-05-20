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
 */
export interface InternalUserSessionInterface {
  readonly id: string;
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
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly webAccount: InternalUserWebAccountInterface | null;
}
