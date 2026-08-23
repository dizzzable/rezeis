/**
 * Identity columns needed to NAME a user on a referral surface.
 *
 * `email`, `telegramId` and `webAccount` are optional so a caller that does
 * not select them still compiles - it simply resolves further down the chain
 * instead of erroring. Every caller that shows the label to an operator should
 * select all of them; see `REFERRAL_USER_SUMMARY_SELECT`.
 */
export interface ReferralUserIdentityFields {
  readonly id: string;
  readonly name: string | null;
  readonly username: string | null;
  readonly email?: string | null;
  readonly telegramId?: bigint | null;
  readonly webAccount?: {
    readonly login: string | null;
    readonly email: string | null;
  } | null;
}

/**
 * Resolves the one string an operator can read for a user.
 *
 * This is a COPY of `buildUserResolveLabel` in
 * `src/modules/users/services/admin-users.service.ts` (the "Allowed users"
 * picker label), which already solves exactly this problem with exactly this
 * precedence: name -> username -> webAccount.login -> email ->
 * webAccount.email -> id. It is a copy and not an import because that function
 * is module-private to the users module and extracting it would mean editing
 * a file this change does not own. IF YOU CHANGE THE ORDER HERE, CHANGE IT
 * THERE TOO - the two are meant to name the same user the same way.
 *
 * Two deliberate differences from the original:
 *
 *  - Telegram id is a FALLBACK here, not a suffix. The original appends
 *    "TG <id>" to whatever it found because its output is a single picker
 *    label; a referral summary already carries `telegramId` as its own field,
 *    so repeating it in the label would print it twice.
 *  - `.trim()` guards the whole chain (inherited from the original): a name of
 *    "   " is not a printable identity, and `??` would have accepted it.
 *
 * Never returns an empty string for a user that exists - `id` is always
 * present and is the last resort, which is what keeps the operator from
 * seeing a dash for a referrer that is really there.
 */
export function buildReferralUserDisplayName(user: ReferralUserIdentityFields): string {
  const primary =
    user.name?.trim() ||
    user.username?.trim() ||
    user.webAccount?.login?.trim() ||
    user.email?.trim() ||
    user.webAccount?.email?.trim() ||
    null;

  if (primary !== null) {
    return primary;
  }
  if (user.telegramId !== null && user.telegramId !== undefined) {
    return `TG ${user.telegramId.toString()}`;
  }
  return user.id;
}
