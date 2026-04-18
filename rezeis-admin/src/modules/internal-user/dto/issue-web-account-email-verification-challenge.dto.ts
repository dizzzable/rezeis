import { IsUUID } from 'class-validator';

/**
 * Accepts the canonical user identifier for internal linked web-account email verification challenge issuance.
 */
export class IssueWebAccountEmailVerificationChallengeDto {
  @IsUUID()
  public readonly userId!: string;
}
