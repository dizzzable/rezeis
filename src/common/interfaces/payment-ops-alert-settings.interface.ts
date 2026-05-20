export interface PaymentOpsAlertSettingsInterface {
  readonly enabled: boolean;
  readonly chatId: string | null;
  readonly threadId: string | null;
  readonly hashtag: string | null;
}

export const DEFAULT_PAYMENT_OPS_ALERT_SETTINGS: PaymentOpsAlertSettingsInterface = {
  enabled: false,
  chatId: null,
  threadId: null,
  hashtag: '#payments_ops',
};
