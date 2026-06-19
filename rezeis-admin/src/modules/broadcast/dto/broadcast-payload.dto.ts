import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { BroadcastAudience } from '@prisma/client';

export class BroadcastPayloadDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  public title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  public text?: string;

  @IsOptional()
  @IsIn(['none', 'photo', 'video'])
  public mediaType?: 'none' | 'photo' | 'video';

  @IsOptional()
  @IsString()
  @MaxLength(256)
  public mediaFileId?: string;

  @IsOptional()
  @IsIn(['HTML', 'MarkdownV2'])
  public parseMode?: 'HTML' | 'MarkdownV2';
}

export class CreateBroadcastDraftDto {
  @IsEnum(BroadcastAudience)
  public audience!: BroadcastAudience;

  @IsOptional()
  @IsString()
  public audiencePlanId?: string;

  @IsOptional()
  @ValidateNested()
  @Type((): typeof BroadcastPayloadDto => BroadcastPayloadDto)
  public payload?: BroadcastPayloadDto;
}

export class UpdateBroadcastDraftDto {
  @IsOptional()
  @IsEnum(BroadcastAudience)
  public audience?: BroadcastAudience;

  @IsOptional()
  @IsString()
  public audiencePlanId?: string;

  @IsOptional()
  @ValidateNested()
  @Type((): typeof BroadcastPayloadDto => BroadcastPayloadDto)
  public payload?: BroadcastPayloadDto;
}

export class SendBroadcastDto {
  /** Optional delay in minutes for scheduled sends. */
  @IsOptional()
  @IsInt()
  @Min(1)
  public delayMinutes?: number;
}

export class EditBroadcastDto {
  @IsString()
  @MaxLength(4096)
  public text!: string;

  @IsOptional()
  @IsIn(['HTML', 'MarkdownV2'])
  public parseMode?: 'HTML' | 'MarkdownV2' | null;
}
