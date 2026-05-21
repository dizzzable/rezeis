export const ERRORS = {
  // ── Generic ───────────────────────────────────────────────────────────────
  INTERNAL_SERVER_ERROR:           { code: 'R000', message: 'Internal server error',                    httpCode: 500 },
  UNAUTHORIZED:                    { code: 'R001', message: 'Unauthorized',                              httpCode: 401 },
  FORBIDDEN:                       { code: 'R002', message: 'Forbidden',                                httpCode: 403 },
  VALIDATION_ERROR:                { code: 'R003', message: 'Validation error',                         httpCode: 400 },

  // ── Auth ──────────────────────────────────────────────────────────────────
  INVALID_CREDENTIALS:             { code: 'A001', message: 'Invalid credentials',                      httpCode: 401 },
  ADMIN_NOT_FOUND:                 { code: 'A002', message: 'Admin not found',                          httpCode: 404 },
  ADMIN_ALREADY_EXISTS:            { code: 'A003', message: 'Admin with this username already exists',  httpCode: 409 },
  JWT_EXPIRED:                     { code: 'A004', message: 'Token expired',                            httpCode: 401 },

  // ── Users ─────────────────────────────────────────────────────────────────
  USER_NOT_FOUND:                  { code: 'U001', message: 'User not found',                           httpCode: 404 },
  USER_ALREADY_BLOCKED:            { code: 'U002', message: 'User is already blocked',                  httpCode: 409 },
  USER_ALREADY_UNBLOCKED:          { code: 'U003', message: 'User is already active',                   httpCode: 409 },
  USER_ROLE_PERMISSION_DENIED:     { code: 'U004', message: 'Insufficient permissions to set this role', httpCode: 403 },

  // ── Plans ─────────────────────────────────────────────────────────────────
  PLAN_NOT_FOUND:                  { code: 'P001', message: 'Plan not found',                           httpCode: 404 },
  PLAN_HAS_ACTIVE_SUBSCRIPTIONS:   { code: 'P002', message: 'Cannot delete plan with active subscriptions', httpCode: 409 },
  PLAN_ALREADY_ARCHIVED:           { code: 'P003', message: 'Plan is already archived',                 httpCode: 409 },

  // ── Subscriptions ─────────────────────────────────────────────────────────
  SUBSCRIPTION_NOT_FOUND:          { code: 'S001', message: 'Subscription not found',                   httpCode: 404 },
  SUBSCRIPTION_ALREADY_ACTIVE:     { code: 'S002', message: 'Subscription is already active',           httpCode: 409 },
  SUBSCRIPTION_ALREADY_DISABLED:   { code: 'S003', message: 'Subscription is already disabled',         httpCode: 409 },

  // ── Payments ──────────────────────────────────────────────────────────────
  PAYMENT_NOT_FOUND:               { code: 'PAY001', message: 'Payment not found',                      httpCode: 404 },
  GATEWAY_NOT_FOUND:               { code: 'PAY002', message: 'Payment gateway not found',               httpCode: 404 },
  CHECKOUT_FAILED:                 { code: 'PAY003', message: 'Failed to create checkout',               httpCode: 500 },
  WEBHOOK_DUPLICATE:               { code: 'PAY004', message: 'Duplicate webhook event',                 httpCode: 409 },

  // ── Promocodes ────────────────────────────────────────────────────────────
  PROMOCODE_NOT_FOUND:             { code: 'PR001', message: 'Promocode not found',                     httpCode: 404 },
  PROMOCODE_EXPIRED:               { code: 'PR002', message: 'Promocode has expired',                    httpCode: 400 },
  PROMOCODE_LIMIT_REACHED:         { code: 'PR003', message: 'Promocode usage limit reached',            httpCode: 400 },
  PROMOCODE_NOT_ELIGIBLE:          { code: 'PR004', message: 'User is not eligible for this promocode',  httpCode: 400 },
  PROMOCODE_ALREADY_USED:          { code: 'PR005', message: 'Promocode already used by this user',      httpCode: 409 },

  // ── Referrals ─────────────────────────────────────────────────────────────
  REFERRAL_INVITE_NOT_FOUND:       { code: 'RF001', message: 'Referral invite not found',                httpCode: 404 },
  REFERRAL_INVITE_EXPIRED:         { code: 'RF002', message: 'Referral invite has expired',              httpCode: 400 },
  REFERRAL_SELF_INVITE:            { code: 'RF003', message: 'Cannot refer yourself',                    httpCode: 400 },
  REFERRAL_ALREADY_EXISTS:         { code: 'RF004', message: 'Referral relationship already exists',     httpCode: 409 },

  // ── Partners ──────────────────────────────────────────────────────────────
  PARTNER_NOT_FOUND:               { code: 'PT001', message: 'Partner not found',                        httpCode: 404 },
  WITHDRAWAL_NOT_FOUND:            { code: 'PT002', message: 'Withdrawal request not found',              httpCode: 404 },
  WITHDRAWAL_ALREADY_PROCESSED:    { code: 'PT003', message: 'Withdrawal request already processed',     httpCode: 409 },
  INSUFFICIENT_BALANCE:            { code: 'PT004', message: 'Insufficient partner balance',              httpCode: 400 },

  // ── Broadcast ─────────────────────────────────────────────────────────────
  BROADCAST_NOT_FOUND:             { code: 'B001', message: 'Broadcast not found',                       httpCode: 404 },
  BROADCAST_ALREADY_SENT:          { code: 'B002', message: 'Broadcast already sent',                    httpCode: 409 },

  // ── Settings ──────────────────────────────────────────────────────────────
  SETTINGS_NOT_FOUND:              { code: 'ST001', message: 'Settings not found',                       httpCode: 404 },

  // ── RemnaWave ─────────────────────────────────────────────────────────────
  REMNAWAVE_UNAVAILABLE:           { code: 'RW001', message: 'RemnaWave panel is unavailable',           httpCode: 503 },
  REMNAWAVE_USER_NOT_FOUND:        { code: 'RW002', message: 'RemnaWave user not found',                  httpCode: 404 },
  REMNAWAVE_SYNC_FAILED:           { code: 'RW003', message: 'Failed to sync with RemnaWave',             httpCode: 500 },

  // ── Notifications ─────────────────────────────────────────────────────────
  NOTIFICATION_TEMPLATE_NOT_FOUND: { code: 'N001', message: 'Notification template not found',           httpCode: 404 },

  // ── Backup ────────────────────────────────────────────────────────────────
  BACKUP_NOT_FOUND:                { code: 'BK001', message: 'Backup not found',                         httpCode: 404 },
  BACKUP_FAILED:                   { code: 'BK002', message: 'Backup creation failed',                    httpCode: 500 },

  // ── Imports ───────────────────────────────────────────────────────────────
  IMPORT_NOT_FOUND:                { code: 'IM001', message: 'Import record not found',                   httpCode: 404 },
  IMPORT_INVALID_FORMAT:           { code: 'IM002', message: 'Invalid import file format',                httpCode: 400 },

  // ── Internal API ──────────────────────────────────────────────────────────
  INTERNAL_UNAUTHORIZED:           { code: 'INT001', message: 'Invalid or missing internal API key',     httpCode: 401 },
  INTERNAL_SIGNATURE_INVALID:      { code: 'INT002', message: 'Request signature is invalid',            httpCode: 401 },
  INTERNAL_TIMESTAMP_EXPIRED:      { code: 'INT003', message: 'Request timestamp is expired',            httpCode: 401 },
} as const;

export type TErrorCode = typeof ERRORS[keyof typeof ERRORS]['code'];
export type TErrorKey = keyof typeof ERRORS;
