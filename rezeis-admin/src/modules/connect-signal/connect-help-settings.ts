/**
 * `settings.connect_help_settings` — «Помощь с подключением», as stored.
 *
 * `{ enabled?: boolean, delayHours?: number, includeTrials?: boolean }`. An
 * absent key, and any value of the wrong kind, reads as OFF / 24 / OFF: an
 * update or a damaged row must never start messaging customers behind the
 * operator's back. Writing belongs to the settings API of the sender, through
 * `mutateSettingsRow`; this reads.
 */

export interface ConnectHelpSettingsView {
  readonly enabled: boolean;
  /** Hours after the purchase (or the grant) the help goes out, 1–168. */
  readonly delayHours: number;
  /** Also trials and gifts, with the same hours. */
  readonly includeTrials: boolean;
}

export const CONNECT_HELP_DEFAULT_DELAY_HOURS = 24;
export const CONNECT_HELP_MIN_DELAY_HOURS = 1;
export const CONNECT_HELP_MAX_DELAY_HOURS = 168;

export function readConnectHelpSettings(raw: unknown): ConnectHelpSettingsView {
  const source =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const hours = source['delayHours'];
  return {
    enabled: source['enabled'] === true,
    delayHours:
      typeof hours === 'number' &&
      Number.isInteger(hours) &&
      hours >= CONNECT_HELP_MIN_DELAY_HOURS &&
      hours <= CONNECT_HELP_MAX_DELAY_HOURS
        ? hours
        : CONNECT_HELP_DEFAULT_DELAY_HOURS,
    includeTrials: source['includeTrials'] === true,
  };
}
