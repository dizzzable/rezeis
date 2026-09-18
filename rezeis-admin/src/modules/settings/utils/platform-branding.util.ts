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

export function readPlatformBranding(value: unknown): PlatformBrandingInterface {
  const record = readRecord(value);
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
    // Absent — every install from before the switch existed — reads as the
    // default, ON: the path has worked since it shipped, and a save of any
    // other branding field must not switch it off by omission.
    subscriptionLinkRecovery:
      typeof record['subscriptionLinkRecovery'] === 'boolean'
        ? (record['subscriptionLinkRecovery'] as boolean)
        : DEFAULT_PLATFORM_BRANDING.subscriptionLinkRecovery,
  };
}

/**
 * Merges a partial platform-branding patch over the existing value. Only keys
 * present on the patch override.
 *
 * The column is not branding's alone: `platformPolicy.externalAuth` is the
 * External auth email policy (`ExternalProviderConfigService.updatePolicy`).
 * The result used to hold the branding keys only, so every Branding save
 * wrote that policy away and the policy page fell back to its defaults. Every
 * key this function does not own is carried over from `existing` as it is —
 * `verification` among them, the retired Telegram templates an install may
 * have stored, which no save writes any more.
 */
export function mergePlatformBranding(input: {
  readonly existing: unknown;
  readonly patch: PlatformBrandingPatch;
}): Record<string, unknown> {
  const current = readPlatformBranding(input.existing);
  const { patch } = input;

  return {
    ...readRecord(input.existing),
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
    subscriptionLinkRecovery:
      patch.subscriptionLinkRecovery !== undefined
        ? patch.subscriptionLinkRecovery
        : current.subscriptionLinkRecovery,
  };
}

/**
 * No `verification`: the retired Telegram templates an older admin SPA still
 * sends are accepted by the DTO (`VerificationTemplatesDto`) and never reach
 * this merge.
 */
export interface PlatformBrandingPatch {
  readonly projectName?: string | null;
  readonly timezone?: string | null;
  readonly webTitle?: string | null;
  readonly channelUsername?: string | null;
  readonly channelRecheck?: boolean;
  readonly requireTelegramWebCredentials?: boolean;
  readonly subscriptionLinkRecovery?: boolean;
}
