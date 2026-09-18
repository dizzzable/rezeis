import { IsString, Length, Matches } from 'class-validator';

/**
 * Body for `POST /api/internal/web-auth/password-reset/consume`.
 *
 * `password` arrives as the SHA-256 hex the cabinet already produces for
 * register / change-password; the panel scrypt-hashes it like every other
 * subscriber credential.
 */
export class PasswordResetConsumeDto {
  @IsString()
  @Length(64, 64, { message: 'token must be a 64-character hex string' })
  @Matches(/^[a-f0-9]+$/i, { message: 'token must be a hex string' })
  public readonly token!: string;

  @IsString()
  @Length(8, 256)
  public readonly password!: string;
}
