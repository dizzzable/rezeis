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
}
