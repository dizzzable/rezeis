import type { SmtpSettingsInterface } from '../../email/interfaces/email.interface';

/**
 * Whether a password-reset link can reach a web account at all.
 * ══════════════════════════════════════════════════════════════
 * ONE definition, because three decisions hang on it and must not drift apart:
 *
 *   - recovery by subscription link is open only to an account this says NO
 *     for (`PasswordResetService.recoverBySubscription`);
 *   - an account created without a password gets its first one through a link,
 *     so the sign-in form can only point such an account at a link when this
 *     says YES (`PasswordResetService.sendFirstPasswordLink`);
 *   - an account without a password that this says NO for cannot get in on its
 *     own at all, and the operator is told (`WebAuthService.login`).
 *
 * A linked Telegram always counts: even when the panel cannot push to the bot,
 * the bot's own "send me a link" (`/start pwreset`) works. An e-mail counts
 * only once VERIFIED — an unconfirmed address may be a typo, and so a
 * stranger's inbox — and only while the operator's SMTP can actually send.
 */
export interface ResetReachability {
  readonly telegramId: bigint | null;
  readonly email: string | null;
  readonly emailVerifiedAt: Date | null;
}

/** "We CAN send mail": SMTP switched on, with a host to send through. */
export function smtpCanDeliver(smtp: Pick<SmtpSettingsInterface, 'enabled' | 'host'>): boolean {
  return smtp.enabled === true && typeof smtp.host === 'string' && smtp.host.trim().length > 0;
}

/** Whether the e-mail on the account is one a reset link may be sent to. */
export function hasVerifiedEmail(account: Pick<ResetReachability, 'email' | 'emailVerifiedAt'>): boolean {
  return account.email !== null && account.emailVerifiedAt !== null;
}

/** `smtpOn` is `smtpCanDeliver` of the operator's settings — asked only when it matters. */
export function canReceiveResetLink(account: ResetReachability, smtpOn: boolean): boolean {
  if (account.telegramId !== null) return true;
  return hasVerifiedEmail(account) && smtpOn;
}
