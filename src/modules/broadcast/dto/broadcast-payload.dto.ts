import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { BroadcastAudience } from '@prisma/client';

export class BroadcastPayloadDto {
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
