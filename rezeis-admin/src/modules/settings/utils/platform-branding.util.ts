/**
 * Reads and merges the `Settings.platformBranding` JSON column into a typed
 * {@link PlatformBrandingInterface}, supplying safe defaults for missing
 * fields. The persisted JSON is merged on top of
 * {@link DEFAULT_PLATFORM_BRANDING}, so partial patches never drop unrelated
 * keys.
 */
import {
  DEFAULT_PLATFORM_BRANDING,
  PlatformBrandingInterface,
  VerificationTemplateLocales,
} from '../interfaces/platform-branding.interface';

function readRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readNullableString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function readLocales(value: unknown): VerificationTemplateLocales {
  const record = readRecord(value);
  return {
    ru: readNullableString(record['ru']),
    en: readNullableString(record['en']),
  };
}

export function readPlatformBranding(value: unknown): PlatformBrandingInterface {
  const record = readRecord(value);
  const verification = readRecord(record['verification']);
  return {
    projectName: readNullableString(record['projectName']),
    timezone: readNullableString(record['timezone']),
    webTitle: readNullableString(record['webTitle']),
    channelUsername: readNullableString(record['channelUsername']),
    channelRecheck:
      typeof record['channelRecheck'] === 'boolean'
        ? (record['channelRecheck'] as boolean)
        : DEFAULT_PLATFORM_BRANDING.channelRecheck,
    requireTelegramWebCredentials:
      typeof record['requireTelegramWebCredentials'] === 'boolean'
        ? (record['requireTelegramWebCredentials'] as boolean)
        : DEFAULT_PLATFORM_BRANDING.requireTelegramWebCredentials,
    verification: {
      telegramTemplate: readLocales(verification['telegramTemplate']),
      passwordResetTelegramTemplate: readLocales(
        verification['passwordResetTelegramTemplate'],
      ),
    },
  };
}

/**
 * Deep-merges a partial platform-branding patch over the existing value.
 * Only keys present on the patch override; nested verification locale maps
 * are merged field-by-field so a partial update preserves the other locale.
 */
export function mergePlatformBranding(input: {
  readonly existing: unknown;
  readonly patch: PlatformBrandingPatch;
}): Record<string, unknown> {
  const current = readPlatformBranding(input.existing);
  const { patch } = input;

  const mergeLocales = (
    base: VerificationTemplateLocales,
    next: Partial<VerificationTemplateLocales> | undefined,
  ): VerificationTemplateLocales => ({
    ru: next?.ru !== undefined ? readNullableString(next.ru) : base.ru,
    en: next?.en !== undefined ? readNullableString(next.en) : base.en,
  });

  return {
    projectName:
      patch.projectName !== undefined
        ? readNullableString(patch.projectName)
        : current.projectName,
    timezone:
      patch.timezone !== undefined ? readNullableString(patch.timezone) : current.timezone,
    webTitle:
      patch.webTitle !== undefined ? readNullableString(patch.webTitle) : current.webTitle,
    channelUsername:
      patch.channelUsername !== undefined
        ? readNullableString(patch.channelUsername)
        : current.channelUsername,
    channelRecheck:
      patch.channelRecheck !== undefined ? patch.channelRecheck : current.channelRecheck,
    requireTelegramWebCredentials:
      patch.requireTelegramWebCredentials !== undefined
        ? patch.requireTelegramWebCredentials
        : current.requireTelegramWebCredentials,
    verification: {
      telegramTemplate: mergeLocales(
        current.verification.telegramTemplate,
        patch.verification?.telegramTemplate,
      ),
      passwordResetTelegramTemplate: mergeLocales(
        current.verification.passwordResetTelegramTemplate,
        patch.verification?.passwordResetTelegramTemplate,
      ),
    },
  };
}

export interface PlatformBrandingPatch {
  readonly projectName?: string | null;
  readonly timezone?: string | null;
  readonly webTitle?: string | null;
  readonly channelUsername?: string | null;
  readonly channelRecheck?: boolean;
  readonly requireTelegramWebCredentials?: boolean;
  readonly verification?: {
    readonly telegramTemplate?: Partial<VerificationTemplateLocales>;
    readonly passwordResetTelegramTemplate?: Partial<VerificationTemplateLocales>;
  };
}
