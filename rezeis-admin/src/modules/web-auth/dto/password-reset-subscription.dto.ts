import { IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';

/**
 * Body for `POST /api/internal/web-auth/password-reset/subscription` — recovery
 * by the VPN subscription link, for an account with no Telegram and no
 * verified e-mail.
 *
 * `login` only selects the account and adds friction: it is not a secret (the
 * panel names Remnawave profiles after it). `clientIp` is the visitor's address
 * as the cabinet saw it — the panel only ever sees the cabinet as its caller,
 * so the per-address budget can key on nothing else. `cabinetUrl` is the
 * cabinet's configured address, for the ordinary link an account WITH a
 * channel is sent instead.
 */
export class PasswordResetSubscriptionDto {
  @IsString()
  @Length(1, 4096)
  public readonly link!: string;

  @IsString()
  @Length(1, 64)
  public readonly login!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public readonly clientIp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  public readonly cabinetUrl?: string;
}
