import {
  DEFAULT_PAYMENT_OPS_ALERT_SETTINGS,
  PaymentOpsAlertSettingsInterface,
} from '../interfaces/payment-ops-alert-settings.interface';

interface PaymentOpsAlertSettingsPatch {
  readonly enabled?: boolean;
  readonly chatId?: string | null;
  readonly threadId?: string | null;
  readonly hashtag?: string | null;
}

export function readPaymentOpsAlertSettings(
  systemNotifications: unknown,
): PaymentOpsAlertSettingsInterface {
  const rootRecord = readRecord(systemNotifications);
  const paymentOpsRecord = readRecord(rootRecord.paymentOps);
  const enabled =
    typeof paymentOpsRecord.enabled === 'boolean'
      ? paymentOpsRecord.enabled
      : DEFAULT_PAYMENT_OPS_ALERT_SETTINGS.enabled;

  return {
    enabled,
    chatId: normalizeChatId(paymentOpsRecord.chatId),
    threadId: normalizeThreadId(paymentOpsRecord.threadId),
    hashtag: normalizeHashtag(paymentOpsRecord.hashtag),
  };
}

export function mergePaymentOpsAlertSettings(input: {
  readonly systemNotifications: unknown;
  readonly patch: PaymentOpsAlertSettingsPatch;
}): Record<string, unknown> {
  const rootRecord = readRecord(input.systemNotifications);
  const currentSettings = readPaymentOpsAlertSettings(rootRecord);
  const nextSettings: PaymentOpsAlertSettingsInterface = {
    enabled:
      input.patch.enabled !== undefined
        ? input.patch.enabled
        : currentSettings.enabled,
    chatId:
      input.patch.chatId !== undefined
        ? normalizeChatId(input.patch.chatId)
        : currentSettings.chatId,
    threadId:
      input.patch.threadId !== undefined
        ? normalizeThreadId(input.patch.threadId)
        : currentSettings.threadId,
    hashtag:
      input.patch.hashtag !== undefined
        ? normalizeHashtag(input.patch.hashtag)
        : currentSettings.hashtag,
  };

  return {
    ...rootRecord,
    paymentOps: nextSettings,
  };
}

function normalizeChatId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    return null;
  }
  return /^-?\d+$/.test(normalizedValue) ? normalizedValue : null;
}

function normalizeThreadId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    return null;
  }
  return /^\d+$/.test(normalizedValue) ? normalizedValue : null;
}

function normalizeHashtag(value: unknown): string | null {
  if (typeof value !== 'string') {
    return DEFAULT_PAYMENT_OPS_ALERT_SETTINGS.hashtag;
  }
  const normalizedValue = value.trim().replace(/\s+/g, '_').replace(/^#+/, '');
  if (normalizedValue.length === 0) {
    return DEFAULT_PAYMENT_OPS_ALERT_SETTINGS.hashtag;
  }
  const safeValue = normalizedValue
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .toLowerCase();
  return `#${safeValue}`;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
