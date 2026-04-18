import { IsUUID } from 'class-validator';

/**
 * Accepts the canonical user identifier for the internal web-account link prompt snooze write path.
 */
export class SnoozeWebAccountLinkPromptDto {
  @IsUUID()
  public readonly userId!: string;
}
