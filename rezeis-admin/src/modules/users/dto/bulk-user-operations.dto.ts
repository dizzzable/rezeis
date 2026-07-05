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

export class BulkUserOperationsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1_000)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  public userIds!: string[];

  @IsIn(['block', 'unblock', 'delete', 'set_language', 'set_max_subscriptions'])
  public action!:
    | 'block'
    | 'unblock'
    | 'delete'
    | 'set_language'
    | 'set_max_subscriptions';

  @IsOptional()
  @IsObject()
  public payload?: Record<string, unknown>;
}
