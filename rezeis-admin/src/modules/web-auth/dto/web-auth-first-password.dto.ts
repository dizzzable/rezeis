import { IsString, Length } from 'class-validator';

/**
 * Body for `POST /api/internal/web-auth/password/first` — a first password for
 * an account that has none, set from a session the customer already holds
 * (the Mini App). `userId` comes from the cabinet's server session; there is
 * no current password to send, because there is none.
 */
export class WebAuthFirstPasswordDto {
  @IsString()
  @Length(1, 256)
  public readonly userId!: string;

  @IsString()
  @Length(8, 256)
  public readonly newPassword!: string;
}
