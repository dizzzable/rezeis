/**
 * Pure helpers behind the anti-fraud settings form, extracted so they can be
 * tested without mounting the tab — same split as
 * `remnawave/settings/cleanup-settings-form-key.ts`.
 */
import type {
  AntiFraudSettings,
  AntiFraudSettingsPatch,
  SharingDetectionConfig,
  SubscriptionUaConfig,
  TrafficAbuseConfig,
} from './settings-api'

/**
 * Remount key for the form.
 *
 * A background refetch must not overwrite half-typed edits, so the form is
 * keyed on the STORED patch it was seeded from: it remounts when the saved
 * settings actually change (a successful save, another operator's edit) and
 * not when an identical payload comes back.
 */
export function getAntiFraudFormKey(settings: AntiFraudSettings | undefined): string {
  return settings ? JSON.stringify(settings.stored) : 'loading'
}

/**
 * One section's effective config as editable form state, numbers held as
 * strings so a half-typed value is not coerced mid-keystroke.
 *
 * Takes ONE section deliberately. `maxNodesPerRun` exists in both the sharing
 * and the traffic-abuse config with different bounds and different meanings, so
 * a single merged map would let the traffic knob silently overwrite the sharing
 * knob — and the form would then save the wrong number to the wrong detector.
 */
export function toFormState(
  config: SharingDetectionConfig | TrafficAbuseConfig | SubscriptionUaConfig,
): Record<string, string | boolean> {
  const state: Record<string, string | boolean> = {}
  for (const [key, value] of Object.entries(config)) {
    state[key] = typeof value === 'boolean' ? value : String(value)
  }
  return state
}

/**
 * The patch for "reset this section to the environment": every field of the
 * section set to `null`, which is how the API is told to drop the stored value
 * and fall back to the `ANTIFRAUD_*` variable — or, for `subscriptionUa`, to the
 * built-in default, which is the only layer that section has under it.
 */
export function buildResetPatch(
  section: 'sharing' | 'trafficAbuse' | 'subscriptionUa',
  fields: readonly string[],
): AntiFraudSettingsPatch {
  return { [section]: Object.fromEntries(fields.map((key) => [key, null])) } as AntiFraudSettingsPatch
}

/**
 * Pulls the server's rejection message out of an axios error. The API names the
 * offending field and its range on a bad value rather than clamping it, so that
 * text is strictly more useful than any generic string the form could invent.
 */
export function serverMessage(error: unknown): string | null {
  const message = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message
  if (typeof message === 'string') return message
  if (Array.isArray(message) && typeof message[0] === 'string') return message[0]
  return null
}
