import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class TwoFactorVerifyDto {
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  public code!: string;
}

export class TwoFactorDisableDto {
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  public code!: string;
}

export class CreateAllowlistEntryDto {
  @IsString()
  @MinLength(7)
  @MaxLength(64)
  public address!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public label?: string;

  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;
}

export class UpdateAllowlistEntryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public label?: string;

  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;
}
