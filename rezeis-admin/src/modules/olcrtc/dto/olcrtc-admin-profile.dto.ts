import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const OLCRTC_PROVIDERS = ['TELEMOST', 'WBSTREAM', 'JITSI'] as const;
export const OLCRTC_TRANSPORTS = ['VP8CHANNEL', 'DATACHANNEL', 'SEICHANNEL', 'VIDEOCHANNEL'] as const;

export class OlcrtcCreateProfileDto {
  @IsString()
  @MaxLength(120)
  public readonly name!: string;

  @IsIn(OLCRTC_PROVIDERS)
  public readonly provider!: (typeof OLCRTC_PROVIDERS)[number];

  @IsIn(OLCRTC_TRANSPORTS)
  public readonly transport!: (typeof OLCRTC_TRANSPORTS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(128)
  public readonly providerAccountId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  public readonly roomTemplate?: string | null;

  @IsOptional()
  @IsObject()
  public readonly transportOptions?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  public readonly priority?: number;

  @IsOptional()
  @IsBoolean()
  public readonly isEnabled?: boolean;

  @IsOptional()
  @IsObject()
  public readonly metadata?: Record<string, unknown>;
}

export class OlcrtcUpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public readonly name?: string;

  @IsOptional()
  @IsIn(OLCRTC_PROVIDERS)
  public readonly provider?: (typeof OLCRTC_PROVIDERS)[number];

  @IsOptional()
  @IsIn(OLCRTC_TRANSPORTS)
  public readonly transport?: (typeof OLCRTC_TRANSPORTS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(128)
  public readonly providerAccountId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  public readonly roomTemplate?: string | null;

  @IsOptional()
  @IsObject()
  public readonly transportOptions?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  public readonly priority?: number;

  @IsOptional()
  @IsBoolean()
  public readonly isEnabled?: boolean;

  @IsOptional()
  @IsObject()
  public readonly metadata?: Record<string, unknown>;
}
