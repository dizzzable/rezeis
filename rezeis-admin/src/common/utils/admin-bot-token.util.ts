import { decryptTotpSecret } from '../../modules/two-factor/utils/secret-cipher';
import { readJsonObject } from './read-json-object.util';

/**
 * Where the panel's own Telegram bot token lives
 * ══════════════════════════════════════════════
 * Exactly one place: `Settings.systemNotifications.botTokenEnc`, AES-GCM
 * ciphertext written by the Bot Token card (`PATCH /admin/settings/platform`,
 * `{ botToken }`). Nothing else writes a token anywhere in this tree.
 *
 * That last sentence is the reason this file exists. `SystemEventsService`
 * — the service every operator event passes through on its way to Telegram —
 * read `systemNotifications.telegram.botToken` instead: a plaintext key at a
 * different path that NO write path has ever produced. So its "do I have a
 * token?" test answered no on every deployment that had one, and every
 * operator card took the split-deployment branch and went out through the
 * reiwa bot. The panel was not choosing to relay; it was failing to find its
 * own token and falling back.
 *
 * Four services had it right (`BackupService`, `BroadcastMediaUploadService`,
 * `PaymentOpsAlertService`, `SettingsService`'s own test buttons) by each
 * calling `SettingsService.getDecryptedBotToken`. A fifth caller could not:
 * `settings.service.ts` imports `system-events.service.ts`, so importing it
 * back would close a module cycle. Hence a pure function over the JSON both
 * sides already hold — one rule, no edge.
 *
 * Reading the plaintext path is NOT preserved as a legacy fallback. It never
 * held a value, and `maskSystemNotifications` drops secrets by top-level key
 * (`email`, `botTokenEnc`, `webPush`) — `telegram` is not among them, so a
 * token at `telegram.botToken` would be served to the SPA in the clear on
 * every settings fetch. Keeping the read would keep that as a supported
 * place to put one.
 */
export function readAdminBotToken(
  systemNotifications: unknown,
  cryptKey: string | null | undefined,
): string | null {
  if (typeof cryptKey !== 'string' || cryptKey.length === 0) return null;
  const enc = readJsonObject(systemNotifications).botTokenEnc;
  if (typeof enc !== 'string' || enc.length === 0) return null;
  try {
    const token = decryptTotpSecret(enc, cryptKey);
    return token.length > 0 ? token : null;
  } catch {
    // Wrong `REZEIS_CRYPT_KEY`, or a truncated column. Either way there is no
    // token to send with, and saying so lets the caller fall back rather than
    // fail. The caller logs — this stays pure so it can be tested without one.
    return null;
  }
}

/**
 * The environment fallback, kept deliberately.
 *
 * Every setting on this product lives in the panel, and `getDecryptedWebPushConfig`
 * argues at length for removing env fallbacks where a second source can
 * DISAGREE with the panel. This one is different in the way that matters: it
 * is only consulted when the panel holds nothing at all, so the two can never
 * both answer. Dropping it would take alerting away from a deployment that
 * genuinely sets `BOT_TOKEN` the moment this shipped, which is its own outage.
 */
export function readEnvBotToken(): string | null {
  const env = process.env.BOT_TOKEN;
  return typeof env === 'string' && env.length > 0 ? env : null;
}
