import { IsString, Matches } from 'class-validator';

/** Body for `POST /api/internal/web-auth/bot-signin/issue`. */
export class BotSigninIssueDto {
  @IsString()
  @Matches(/^\d{1,19}$/, { message: 'telegramId must be a positive numeric string up to 19 digits' })
  public readonly telegramId!: string;
}
