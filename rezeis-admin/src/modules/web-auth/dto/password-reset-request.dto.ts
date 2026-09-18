import { IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';

/**
 * Body for `POST /api/internal/web-auth/password-reset/request` — the cabinet's
 * "forgot password" form.
 *
 * `identifier` is what the customer typed: their login, or the e-mail they
 * VERIFIED on the account (an unverified address never finds anything).
 *
 * `cabinetUrl` is the cabinet's own public address, read from ITS configuration
 * (never from the request's Host header, which the visitor controls). Only its
 * origin is used, to build the link the e-mail and the Telegram button carry.
 * Absent, e-mail cannot carry a link and the Telegram button falls back to the
 * bot's own cabinet address.
 */
export class PasswordResetRequestDto {
  @IsString()
  @Length(3, 254)
  public readonly identifier!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  public readonly cabinetUrl?: string;
}
