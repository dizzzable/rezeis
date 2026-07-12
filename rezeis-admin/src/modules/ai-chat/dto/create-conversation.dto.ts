import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload for creating a new AI chat conversation.
 */
export class CreateConversationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public userId!: string;
}
