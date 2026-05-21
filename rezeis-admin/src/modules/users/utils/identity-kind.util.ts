/**
 * Identity kind classification for admin user detail views.
 *
 * In altshop the same notion is computed in
 * `src/bot/routers/dashboard/users/user/getters_identity.py`. We rebuild it
 * here using our own data model: `User.id` (CUID) is the stable
 * cross-channel identifier, so we never need a `panelSyncTelegramId`
 * override.
 *
 * Buckets:
 *   • TELEGRAM_LINKED      — user has a telegramId AND a webAccount whose
 *                            credentials are bootstrapped (login + password
 *                            actually set by the user). Both rails work.
 *   • TELEGRAM_PROVISIONAL — telegramId AND a webAccount, but credentials
 *                            were never bootstrapped (admin-issued temp,
 *                            not yet activated by the user).
 *   • TELEGRAM_ONLY        — telegramId set, no linked webAccount.
 *   • WEB_ONLY             — webAccount exists, no telegramId.
 *   • LOCAL_ONLY           — neither telegramId nor webAccount. Happens
 *                            when an admin creates a user manually with
 *                            only a name. Specific to rezeis-admin; altshop
 *                            cannot represent this.
 */
export type IdentityKind =
  | 'TELEGRAM_LINKED'
  | 'TELEGRAM_PROVISIONAL'
  | 'TELEGRAM_ONLY'
  | 'WEB_ONLY'
  | 'LOCAL_ONLY';

export interface IdentityKindInputs {
  readonly telegramId: bigint | string | null;
  readonly webAccount: {
    readonly login: string | null;
    readonly credentialsBootstrappedAt: Date | null;
  } | null;
}

/**
 * Resolves the `IdentityKind` for a given user snapshot.
 *
 * Pure function — no DB access. Caller is responsible for hydrating both
 * the user row and the web account.
 */
export function resolveIdentityKind(input: IdentityKindInputs): IdentityKind {
  const hasTelegram = input.telegramId !== null && input.telegramId !== undefined;
  const webAccount = input.webAccount;
  const hasWeb = webAccount !== null && webAccount.login !== null;
  if (hasTelegram && hasWeb) {
    return webAccount.credentialsBootstrappedAt === null
      ? 'TELEGRAM_PROVISIONAL'
      : 'TELEGRAM_LINKED';
  }
  if (hasTelegram) {
    return 'TELEGRAM_ONLY';
  }
  if (hasWeb) {
    return 'WEB_ONLY';
  }
  return 'LOCAL_ONLY';
}
