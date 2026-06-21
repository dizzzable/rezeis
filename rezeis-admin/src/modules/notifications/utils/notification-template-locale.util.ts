/**
 * notification-template-locale.util
 * ─────────────────────────────────
 * Pure helpers that resolve a `NotificationTemplate` row + the recipient's
 * locale into the actual copy + buttons to deliver. Backed by a unit test
 * suite — keep these functions pure (no DB / no logging) so the locale
 * fallback is total and behaves identically in tests and runtime.
 *
 * Locale fallback rule: `EN` users see EN copy when `bodyEn` (or
 * `titleEn`) is non-empty after trim; otherwise the bot delivers the RU
 * column. RU users always get the RU column.
 *
 * Button validation rule: `webApp` requires a non-empty `target`; `url`
 * requires an HTTPS-safe URL (rejects `localhost`/`127.0.0.1` like
 * Telegram itself); `callback` requires a non-empty `target`. Invalid
 * rows are dropped at delivery (degrade, never fail).
 */
import type { NotifyButton } from '../services/bot-notifier.client';

/** Locale codes the notifications layer recognises. */
export type NotificationLocale = 'ru' | 'en';

/** The fields the helpers need from a stored template row. */
export interface NotificationTemplateLocaleSlice {
  readonly title: string;
  readonly body: string;
  readonly titleEn: string | null;
  readonly bodyEn: string | null;
}

/** The fields the helpers need to resolve a stored buttons array. */
export interface NotificationTemplateButtonsSlice {
  readonly buttons: unknown;
}

/** Single stored button entry — shape mirrors the DTO and the frontend. */
export interface StoredNotificationButton {
  readonly labelRu: string;
  readonly labelEn?: string | null;
  readonly kind: 'webApp' | 'url' | 'callback';
  readonly target: string;
}

/**
 * Map the `User.language` enum string ("RU"/"EN"/…) to the locale codes
 * the helpers below understand. Anything that isn't recognisably RU is
 * treated as `en` so a multilingual catalog defaults to EN copy when
 * authored.
 */
export function coerceNotificationLocale(language: string | null | undefined): NotificationLocale {
  if (typeof language !== 'string') return 'ru';
  return language.toUpperCase() === 'RU' ? 'ru' : 'en';
}

/**
 * Pick `(title, body)` for the recipient locale. EN with empty
 * `titleEn`/`bodyEn` falls back per-field to the RU column — so an
 * operator who translated only the body still gets a localised body
 * with the RU title rather than two RU strings.
 */
export function resolveTemplateLocale(
  template: NotificationTemplateLocaleSlice,
  locale: NotificationLocale,
): { readonly title: string; readonly body: string } {
  if (locale !== 'en') {
    return { title: template.title, body: template.body };
  }
  const enTitle = (template.titleEn ?? '').trim();
  const enBody = (template.bodyEn ?? '').trim();
  return {
    title: enTitle.length > 0 ? template.titleEn! : template.title,
    body: enBody.length > 0 ? template.bodyEn! : template.body,
  };
}

/** True when `value` has the canonical stored-button shape. */
export function isStoredNotificationButton(value: unknown): value is StoredNotificationButton {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.labelRu !== 'string') return false;
  if (v.labelEn !== undefined && v.labelEn !== null && typeof v.labelEn !== 'string') return false;
  if (v.kind !== 'webApp' && v.kind !== 'url' && v.kind !== 'callback') return false;
  if (typeof v.target !== 'string') return false;
  return true;
}

/**
 * Read the stored `buttons` JSON column (which is `unknown` to TypeScript)
 * into a typed array. Drops rows whose shape doesn't match — the JSON
 * can come from a manual SQL edit or a future schema change, so this is
 * the trust boundary.
 */
export function readStoredButtons(raw: unknown): readonly StoredNotificationButton[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isStoredNotificationButton);
}

/**
 * Telegram-safe URL gate, mirroring reiwa's
 * `widgets/main-keyboard.ts#isTelegramSafeButtonUrl`. Reproduced here so
 * we don't pull a reiwa import into rezeis just for this guard.
 */
function isTelegramSafeUrl(url: string): boolean {
  if (!url.startsWith('https://')) return false;
  const lower = url.toLowerCase();
  if (lower.includes('://localhost') || lower.includes('://127.0.0.1')) return false;
  return true;
}

/**
 * Validate one stored row. Returns `null` when the row should be
 * dropped at delivery time. Used by `resolveTemplateButtons` and by the
 * bot-map composer when flagging invalid edges.
 */
export function validateStoredButton(button: StoredNotificationButton): boolean {
  switch (button.kind) {
    case 'webApp':
      return button.target.trim().length > 0;
    case 'url':
      return isTelegramSafeUrl(button.target.trim());
    case 'callback':
      return button.target.trim().length > 0;
  }
}

/**
 * Resolve the stored `buttons` JSON into the runtime `NotifyButton`
 * shape consumed by `BotNotifierClient`. Per-locale label resolution +
 * invalid-row drop. The order is preserved.
 */
export function resolveTemplateButtons(
  template: NotificationTemplateButtonsSlice,
  locale: NotificationLocale,
): NotifyButton[] {
  const stored = readStoredButtons(template.buttons);
  const result: NotifyButton[] = [];
  for (const row of stored) {
    if (!validateStoredButton(row)) continue;
    const label = pickButtonLabel(row, locale);
    if (row.kind === 'webApp') {
      result.push({ text: label, webAppPath: row.target.trim() });
    } else if (row.kind === 'url') {
      result.push({ text: label, url: row.target.trim() });
    } else {
      result.push({ text: label, callbackData: row.target.trim() });
    }
  }
  return result;
}

function pickButtonLabel(button: StoredNotificationButton, locale: NotificationLocale): string {
  if (locale === 'en') {
    const en = (button.labelEn ?? '').trim();
    if (en.length > 0) return button.labelEn!;
  }
  return button.labelRu;
}
