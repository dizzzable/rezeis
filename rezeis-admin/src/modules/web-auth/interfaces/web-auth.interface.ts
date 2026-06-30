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
 * Result of `POST /api/internal/web-auth/recover`.
 *
 *   - `telegram`: a verification code was generated and the bot will
 *     deliver it on the next user message (or via realtime stream when
 *     the bot is configured to push). `challengeId` is opaque to reiwa.
 *   - `email`:    a magic-link/email-OTP was sent.
 *   - `none`:     user has neither a verified email nor a linked Telegram
 *                 account — recovery is impossible without operator help.
 */
export interface WebAuthRecoverResultInterface {
  readonly method: 'telegram' | 'email' | 'none';
  readonly challengeId?: string;
}

export interface WebAuthChangePasswordResultInterface {
  readonly success: boolean;
}

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
