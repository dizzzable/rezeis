import { IsIn, IsOptional } from 'class-validator';

/**
 * Body for the enforcement endpoint. `mode` selects whether to drop the
 * flagged user's connections (default) or the specific IPs recorded in the
 * signal metadata.
 */
export class EnforceFraudSignalDto {
  @IsOptional()
  @IsIn(['user', 'ip'])
  readonly mode?: 'user' | 'ip';
}
