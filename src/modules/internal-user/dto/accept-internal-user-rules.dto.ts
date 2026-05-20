import { IsUUID } from 'class-validator';

/**
 * Accepts the canonical user identifier for the internal rules-acceptance write path.
 */
export class AcceptInternalUserRulesDto {
  @IsUUID()
  public readonly userId!: string;
}
