import { IsString, Length, Matches } from 'class-validator';

/**
 * Body for `POST /api/internal/web-auth/telegram-claim`.
 *
 * Self-service account link from the Mini App: a Telegram user (proven by the
 * BFF via `initData`) submits the login + password of their EXISTING web
 * account. The endpoint binds the Telegram id to that account when it is safe:
 *   - the Telegram id is unlinked, or
 *   - it is owned by the same account (idempotent), or
 *   - it is owned by an EMPTY shell account (auto-retired).
 * When the Telegram-owner has material data the endpoint refuses
 * (`needs_admin_merge`) — the operator merges via the admin panel.
 *
 * `password` arrives as the SHA-256 hex the SPA already produces (mirrors
 * `register` / `claim`); admin scrypt-verifies it against the stored hash.
 */
export class WebAuthTelegramClaimDto {
  @IsString()
  @Matches(/^\d{1,19}$/, { message: 'telegramId must be a numeric Telegram id' })
  public readonly telegramId!: string;

  @IsString()
  @Length(3, 64)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: 'login may contain only letters, digits, dot, underscore and hyphen',
  })
  public readonly login!: string;

  @IsString()
  @Length(8, 256)
  public readonly password!: string;
}
