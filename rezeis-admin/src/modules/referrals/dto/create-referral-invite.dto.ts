import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateReferralInviteDto {
  @IsString()
  public inviterId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  public note?: string;

  /**
   * Explicit `null` means "never expires" and is honoured as-is. An ABSENT
   * field is resolved from the operator's configured link TTL — the per-user
   * override, the `linkTtlEnabled` switch and the VIP bypass — and is NOT a
   * fixed default window.
   *
   * The distinction still matters and the two must not collapse: `null` STATES
   * the answer, absence ASKS for it. The internal path passes `null` when
   * link-TTL is disabled or the inviter holds the bypass, so that a permanent
   * link cannot be handed back a lifetime by anything downstream.
   */
  @IsOptional()
  @IsISO8601()
  public expiresAt?: string | null;

  /**
   * Convenience for callers that prefer to specify a TTL instead of an ISO
   * timestamp. When both `expiresAt` and `expiresInDays` are provided the
   * explicit `expiresAt` wins.
   *
   * `@ValidateIf` rather than `@IsOptional()`, because the two differ on
   * exactly the value that mattered: `@IsOptional()` skips validation for
   * `null` AS WELL AS `undefined`, so `expiresInDays: null` sailed through
   * into `resolveInviteExpiry`, took the `!== undefined` branch, and reached
   * `addDays(new Date(), null)` - which returns the reference date unchanged.
   * The operator got an invite that was already expired the instant it was
   * created, with no error raised anywhere. `@ValidateIf` skips only a truly
   * absent field, so `null` now meets `@IsInt()` and is refused.
   *
   * Refused, NOT reinterpreted as "no expiry": that already has its own
   * spelling one field up (`expiresAt: null`), and a caller writing the very
   * natural `expiresInDays: someValue ?? null` would otherwise mint a
   * PERMANENT invite by accident. A permanent link is invisible - it never
   * trips the `expiresAt: { gt: now }` sweeps and has to be revoked by hand -
   * which makes it the worse of the two failures.
   */
  @ValidateIf((object: CreateReferralInviteDto): boolean => object.expiresInDays !== undefined)
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  public expiresInDays?: number;
}
