import { IsString, Matches } from 'class-validator';

/**
 * Body for `POST /api/internal/web-auth/password-reset/telegram` — the bot asks
 * for a reset link on behalf of the Telegram user it is talking to. The id is
 * the one Telegram gave the bot, never a value typed by anyone.
 */
export class PasswordResetTelegramDto {
  @IsString()
  @Matches(/^\d{1,19}$/, { message: 'telegramId must be a positive numeric string up to 19 digits' })
  public readonly telegramId!: string;
}
