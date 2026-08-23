import { IsArray, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class PromocodePlanSnapshotDto {
  @IsString()
  @MaxLength(64)
  public id!: string;

  @IsString()
  @MaxLength(120)
  public name!: string;

  @IsString()
  @MaxLength(32)
  public type!: string;

  /**
   * Whole gigabytes, or absent/`null` for UNLIMITED. Never `0`.
   *
   * `promocode-rewards.service.ts` copies this straight into
   * `Subscription.trafficLimit` when it mints a subscription, so this decorator
   * is the gate on a value the panel CANNOT EXPRESS. Remnawave spells unlimited
   * traffic `0` bytes — it has no encoding for "zero bytes allowed" at all — so
   * a locally-stored `trafficLimit: 0` is pushed upstream as UNLIMITED, the
   * exact opposite of what it means, and read back as `null`. The projection
   * then never matches what it sent, is never stamped APPLIED, and the sync job
   * reports drift forever. See `remnawave/utils/panel-traffic-limit.util.ts`.
   *
   * `@Min(1)` matches `create-plan.dto.ts` and `update-plan.dto.ts`, which have
   * always been `@Min(1)`. This field was the one snapshot of a plan that let
   * `0` through.
   *
   * DO NOT "harmonise" this with `deviceLimit` below. The two columns are
   * deliberately ASYMMETRIC: `deviceLimit <= 0` is the product's canonical
   * unlimited (and matches the panel's own `hwidDeviceLimit: 0`), while
   * `trafficLimit: null` is unlimited and `0` would mean genuinely no traffic.
   * Same digit, opposite meanings, one field apart.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  public trafficLimit?: number | null;

  /** `0` is UNLIMITED here — see the warning above. Not a typo, do not raise. */
  @IsInt()
  @Min(0)
  public deviceLimit!: number;

  @IsString()
  @MaxLength(32)
  public trafficLimitStrategy!: string;

  @IsArray()
  @IsString({ each: true })
  public internalSquads!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public externalSquad?: string | null;

  @IsOptional()
  @IsInt()
  @Min(-1)
  public duration?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public tag?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public description?: string | null;

  /**
   * Plan icon frozen into the granted subscription's snapshot, so a
   * promocode-issued subscription shows the same glyph a paid purchase would.
   * Required here because global validation runs with `forbidNonWhitelisted`,
   * so an admin form sending `icon` would otherwise be rejected outright.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public icon?: string | null;
}
