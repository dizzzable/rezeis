import { AccessMode, Currency } from '@prisma/client';

/**
 * Describes the user-safe platform policy payload exposed to the internal edge.
 */
export interface InternalPlatformPolicyInterface {
  readonly rulesRequired: boolean;
  readonly rulesLink: string | null;
  readonly channelRequired: boolean;
  readonly channelLink: string | null;
  readonly accessMode: AccessMode;
  readonly inviteModeStartedAt: string | null;
  readonly defaultCurrency: Currency;
}
