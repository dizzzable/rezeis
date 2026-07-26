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

  @IsOptional()
  @IsInt()
  @Min(0)
  public trafficLimit?: number | null;

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
