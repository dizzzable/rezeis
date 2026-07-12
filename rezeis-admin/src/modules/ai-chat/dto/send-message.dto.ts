import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload for sending a message to the AI chat assistant.
 */
export class SendMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public userId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  public message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public conversationId?: string;
}
