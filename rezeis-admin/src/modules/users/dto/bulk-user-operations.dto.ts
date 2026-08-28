import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import type { BulkUserAction } from '../services/bulk-user-operations.service';

export class BulkUserOperationsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1_000)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  public userIds!: string[];

  /**
   * Kept as a literal list rather than derived from `BulkUserAction`:
   * `class-validator` needs runtime values, and a decorator that drifted from
   * the union would accept an action the service cannot dispatch — which the
   * exhaustiveness guard there answers with a 200 and an error row per user,
   * not with a 400.
   */
  @IsIn([
    'block',
    'unblock',
    'delete',
    'set_language',
    'set_max_subscriptions',
    'reset_traffic',
    'resync_profiles',
    'revoke_devices',
    'extend_subscription',
  ])
  public action!: BulkUserAction;

  @IsOptional()
  @IsObject()
  public payload?: Record<string, unknown>;
}
