/**
 * Result of `POST /api/internal/web-auth/register`.
 *
 * `userId` is the canonical reiwa_id (CUID) the caller should treat as the
 * stable user identity going forward. `webAccountId` is exposed mostly for
 * audit-log correlation; it is not required for any subsequent call.
 */
export interface WebAuthRegisterResultInterface {
  readonly userId: string;
  readonly webAccountId: string;
}

/**
 * Result of `POST /api/internal/web-auth/login`.
 *
 *  - `requiresPasswordChange`: bootstrap step (admin-issued temporary
 *    password); reiwa SPA must redirect to `/change-password` first.
 *  - `telegramLinked` / `emailVerified`: drive the recovery affordances
 *    in the SPA settings (greyed-out vs primary).
 */
export interface WebAuthLoginResultInterface {
  readonly userId: string;
  readonly requiresPasswordChange: boolean;
  readonly telegramLinked: boolean;
  readonly emailVerified: boolean;
}

/**
 * Result of `POST /api/internal/web-auth/recover` — the route cabinets up to
 * 0.9.7.45 call, kept for them with the answers it always gave. It SENDS
 * NOTHING: those cabinets have no page a reset link could open. The newer
 * cabinet calls `password-reset/request` and shows every visitor one answer.
 *
 *   - `telegram`: the account has Telegram linked.
 *   - `email`:    it has a verified e-mail and SMTP is on.
 *   - `none`:     no such account, or neither.
 */
export interface WebAuthRecoverResultInterface {
  readonly method: 'telegram' | 'email' | 'none';
  readonly challengeId?: string;
}

/**
 * `sessionsRevokedAt`: every cabinet session of the account opened before this
 * instant is now signed out. The cabinet gives the browser that made the change
 * a fresh session that counts from it, so that one stays signed in.
 */
export interface WebAuthChangePasswordResultInterface {
  readonly success: boolean;
  readonly sessionsRevokedAt: string;
}

/**
 * `POST /api/internal/web-auth/sessions/state` — asked by the cabinet at most
 * once a minute per session. A session that started before `sessionsRevokedAt`
 * is signed out; `null` means nothing was ever revoked for this account (or it
 * has no web account at all).
 */
export interface WebSessionsStateResultInterface {
  readonly sessionsRevokedAt: string | null;
}

/** `POST /api/internal/web-auth/sessions/revoke` — «Выйти на всех устройствах». */
export interface WebSessionsRevokeResultInterface {
  readonly sessionsRevokedAt: string;
}

/**
 * `POST /api/internal/web-auth/password/state` — whether the signed-in
 * customer's account has a password, so the cabinet knows which form to show:
 * "current and new" or, for an account imported without one, "a first one".
 */
export interface WebPasswordStateResultInterface {
  readonly hasPassword: boolean;
  readonly login: string | null;
}

/**
 * `POST /api/internal/web-auth/password/first` — a first password, set from a
 * session the customer already has:
 *   - `set`          — stored; `login` is for the «Сохраните данные для входа»
 *                      screen, `sessionsRevokedAt` as for a password change;
 *   - `has_password` — the account has one (perhaps set a moment ago by a
 *                      concurrent request): nothing was written;
 *   - `no_account`   — no usable web account (none, no login, or blocked).
 */
export type WebFirstPasswordResultInterface =
  | { readonly status: 'set'; readonly login: string; readonly sessionsRevokedAt: string }
  | { readonly status: 'has_password' | 'no_account' };

/**
 * Outcome of `POST /api/internal/web-auth/telegram-claim` (self-service link
 * of a Telegram id to an existing web account):
 *   - `linked`            — the Telegram id is now bound to the account
 *                           (`userId` returned); the BFF re-mints the session.
 *   - `already_linked`    — it was already bound to this account (idempotent).
 *   - `needs_admin_merge` — the Telegram id is owned by a different account
 *                           that has material data; an operator must merge.
 *   - `web_account_has_other_telegram` — the target account is already linked
 *                           to a different Telegram id.
 */
export type WebAuthTelegramClaimStatus =
  | 'linked'
  | 'already_linked'
  | 'needs_admin_merge'
  | 'web_account_has_other_telegram';

export interface WebAuthTelegramClaimResultInterface {
  readonly status: WebAuthTelegramClaimStatus;
  readonly userId?: string;
}

/**
 * Result of `POST /api/internal/web-auth/bot-signin/issue`.
 *
 * Plaintext token is delivered exactly once on this response and never
 * persisted in our DB — only `sha256(token)` lives in Redis. Callers
 * embed the token in a URL the user receives in Telegram and must not
 * log or echo it. `null` means the user can't be resolved (corrupt
 * state) or is blocked — caller should fall back to a tokenless
 * cabinet URL.
 */
export interface WebAuthBotSigninIssueResultInterface {
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Result of `POST /api/internal/web-auth/bot-signin/consume`.
 *
 * `userId` is the canonical reiwa_id the BFF binds to a fresh
 * WebSession. `null` is encoded as the absence of `userId`; the BFF
 * surfaces it as a 401 to the SPA which then redirects to `/sign-in`
 * with an `?error=expired_link` hint.
 */
export interface WebAuthBotSigninConsumeResultInterface {
  readonly userId: string | null;
}

/** How a password was (or is being) recovered. Travels in the reset token and the event. */
export type PasswordRecoveryMethod = 'telegram' | 'email' | 'subscription_link';

/**
 * Result of `POST /api/internal/web-auth/password-reset/request`.
 *
 * `method` is for logs and the legacy route only. `resetLinks: true` is
 * constant — the cabinet reads it as "this panel sends reset links" and never
 * shows a visitor anything that depends on `method`.
 */
export interface PasswordResetRequestResultInterface {
  readonly method: 'telegram' | 'email' | 'none';
  readonly resetLinks: true;
}

/** Result of `POST /api/internal/web-auth/password-reset/inspect`. */
export type PasswordResetInspectResultInterface =
  | { readonly status: 'valid'; readonly login: string; readonly expiresAt: string }
  | { readonly status: 'expired' | 'used' };

/** Result of `POST /api/internal/web-auth/password-reset/consume`. */
/**
 * `ok.sessionsRevokedAt`: every cabinet session of the account opened before
 * this instant is signed out; the cabinet opens the new one after it.
 */
export type PasswordResetConsumeResultInterface =
  | {
      readonly status: 'ok';
      readonly userId: string;
      readonly login: string;
      readonly sessionsRevokedAt: string;
    }
  | { readonly status: 'expired' | 'used' };

/**
 * Result of `POST /api/internal/web-auth/password-reset/telegram` — the bot's
 * "send me a reset link" for the Telegram user it is talking to. The plaintext
 * token exists only in this response; the bot puts it in a button that points
 * at its own cabinet address and nowhere else.
 */
export type PasswordResetTelegramResultInterface =
  | {
      readonly status: 'issued';
      readonly token: string;
      readonly login: string;
      readonly expiresAt: string;
    }
  /**
   * `recently_sent`: a link went out within the last minute. `hourly_limit`:
   * the hour's five links already went out. `unavailable`: nothing could be
   * stored or counted (Redis). Each is a different sentence to the customer.
   */
  | { readonly status: 'no_account' | 'recently_sent' | 'hourly_limit' | 'unavailable' };

/**
 * Result of `POST /api/internal/web-auth/password-reset/first-password` — what
 * the cabinet's sign-in form asks after a refused sign-in, for an account the
 * AltShop importer created without a password.
 *
 *  - `sent`: the ordinary reset link went to `channel` now, or within the last
 *    minute;
 *  - `hourly_limit`: the hour's five links already went out;
 *  - `use_bot`: Telegram is linked but the panel cannot push to the bot — the
 *    bot's own "send me a link" works;
 *  - `unavailable`: nothing could be sent (Redis did not answer);
 *  - `not_applicable`: anything else, and the sign-in form shows its ordinary
 *    refusal — no such login, a password already set, a blocked account, or
 *    an account no link can reach.
 */
export type PasswordResetFirstPasswordResultInterface =
  | { readonly status: 'sent'; readonly channel: 'telegram' | 'email' }
  | { readonly status: 'hourly_limit' | 'use_bot' | 'unavailable' | 'not_applicable' };

/**
 * Result of `POST /api/internal/web-auth/password-reset/subscription`.
 *
 *  - `verified`: an account with no channel; the token continues on the
 *    cabinet's reset page (policy A — see `grantLinkOnlyRecovery`).
 *  - `sent_to_channels`: the account HAS a channel; the ordinary reset link
 *    went there, and the cabinet shows the recovery form's one answer.
 *  - `mismatch`: the one answer for EVERY failed verification — wrong link,
 *    wrong login, an expired subscription, an account locked on this path — so
 *    it cannot tell anybody which half they got wrong.
 *  - `disabled`: the operator switched the path off («Восстановление пароля по
 *    ссылке подписки»). Answered before anything is looked up, so it is the
 *    same for every link and login.
 */
export type PasswordResetSubscriptionResultInterface =
  | {
      readonly status: 'verified';
      readonly token: string;
      readonly login: string;
      readonly expiresAt: string;
    }
  | { readonly status: 'sent_to_channels' }
  | { readonly status: 'mismatch' }
  | { readonly status: 'disabled' }
  | { readonly status: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly status: 'unavailable' };
