/**
 * The @username of the customer's CURRENTLY linked Telegram account, as
 * Telegram itself last reported it — or `null`.
 *
 * `users.telegram_username` + `users.telegram_username_tg_id` are written as a
 * pair by one writer only: the Telegram-verified bootstrap (bot `/start` and
 * the Mini App sign-in, `InternalUserEdgeService.bootstrapByTelegram`), from
 * the very update Telegram signed. The pair says "Telegram account `tg_id` had
 * this nick, or none". It is worth something only while that account is still
 * the one linked: a rebind, a link or a merge moves `telegram_id` and leaves
 * the pair naming the old account, which reads here as "unknown" — no clean-up
 * code anywhere, and nothing to forget.
 *
 * `null` covers three different facts that all mean "no nick to use": the
 * account has none (verified), the pair names a different account, and the
 * row was never bootstrapped since the pair existed. `users.username` is no
 * substitute: every importer and the admin «create user» form write it too,
 * and it survives a rebind naming the previous account.
 */
export interface VerifiedTelegramUsernameSource {
  readonly telegramId: bigint | null;
  readonly telegramUsername: string | null;
  readonly telegramUsernameTgId: bigint | null;
}

export function verifiedTelegramUsername(user: VerifiedTelegramUsernameSource): string | null {
  if (user.telegramId === null || user.telegramUsernameTgId === null) return null;
  if (user.telegramUsernameTgId !== user.telegramId) return null;
  return user.telegramUsername;
}
