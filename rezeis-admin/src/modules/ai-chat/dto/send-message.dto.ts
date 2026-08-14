import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload for sending a message to the AI chat assistant.
 *
 * Carries no subject id. It used to open with `userId`, which the controller
 * passed straight through as the conversation's owner — so the body decided
 * whose conversation was written to. The owner now comes from `@CurrentAdmin()`
 * and the field is gone rather than made optional: an unread identifier that
 * still reads like an owner is how this got wired up the first time.
 */
export class SendMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  public message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public conversationId?: string;
}
