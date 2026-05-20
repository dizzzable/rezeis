import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class UpdatePaymentOpsAlertSettingsDto {
  @IsOptional()
  @IsBoolean()
  public enabled?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^-?\d+$/, { message: 'chatId must be a valid integer string' })
  public chatId?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'threadId must be a valid integer string' })
  public threadId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public hashtag?: string | null;
}

export class SendPaymentOpsAlertTestDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  public note?: string;
}
