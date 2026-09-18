import { IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';

/**
 * Body for `POST /api/internal/web-auth/password-reset/first-password` — the
 * cabinet's sign-in form, after a refused sign-in, asking whether the login is
 * an account with no password yet and, if so, having its reset link sent.
 *
 * Its own route rather than a field on `login`: `login` is also called by
 * cabinets that predate this, and this panel refuses unknown body fields, so a
 * new field there would break sign-in for a newer cabinet talking to an older
 * panel. `cabinetUrl` is the cabinet's configured address, for the link.
 */
export class PasswordResetFirstPasswordDto {
  @IsString()
  @Length(3, 64)
  public readonly login!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  public readonly cabinetUrl?: string;
}
