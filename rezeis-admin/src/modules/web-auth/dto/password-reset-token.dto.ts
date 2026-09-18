import { IsString, Length, Matches } from 'class-validator';

/** Body for `POST /api/internal/web-auth/password-reset/inspect`. */
export class PasswordResetTokenDto {
  @IsString()
  @Length(64, 64, { message: 'token must be a 64-character hex string' })
  @Matches(/^[a-f0-9]+$/i, { message: 'token must be a hex string' })
  public readonly token!: string;
}
