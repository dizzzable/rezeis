import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

import { OLCRTC_PROVIDERS } from './olcrtc-admin-profile.dto';

export class OlcrtcCreateProviderAccountDto {
  @IsIn(OLCRTC_PROVIDERS)
  public readonly provider!: (typeof OLCRTC_PROVIDERS)[number];

  @IsString()
  @MaxLength(120)
  public readonly name!: string;

  @IsOptional()
  @IsObject()
  public readonly credentials?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  public readonly credentialHint?: string | null;

  @IsOptional()
  @IsBoolean()
  public readonly isEnabled?: boolean;

  @IsOptional()
  @IsObject()
  public readonly metadata?: Record<string, unknown>;
}

export class OlcrtcUpdateProviderAccountDto {
  @IsOptional()
  @IsIn(OLCRTC_PROVIDERS)
  public readonly provider?: (typeof OLCRTC_PROVIDERS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly name?: string;

  @IsOptional()
  @IsObject()
  public readonly credentials?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  public readonly credentialHint?: string | null;

  @IsOptional()
  @IsBoolean()
  public readonly isEnabled?: boolean;

  @IsOptional()
  @IsObject()
  public readonly metadata?: Record<string, unknown>;
}
