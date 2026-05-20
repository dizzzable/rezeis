import { AccessMode, Currency } from '@prisma/client';

/**
 * Describes the platform settings payload exposed by the admin API.
 */
export interface PlatformSettingsInterface {
  readonly rulesRequired: boolean;
  readonly rulesLink: string | null;
  readonly channelRequired: boolean;
  readonly channelId: string | null;
  readonly channelLink: string | null;
  readonly accessMode: AccessMode;
  readonly inviteModeStartedAt: string | null;
  readonly defaultCurrency: Currency;
  readonly updatedAt: string;
}
