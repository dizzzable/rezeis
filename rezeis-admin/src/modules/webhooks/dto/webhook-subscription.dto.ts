import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateWebhookSubscriptionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  public name!: string;

  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2_048)
  public url!: string;

  /**
   * Pass an empty array (or `["*"]`) to subscribe to every event.
   * Specific event types must come from the catalog; namespace wildcards
   * (`payment.*`) are also accepted.
   */
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  public eventTypes!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public description?: string;

  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;
}

export class UpdateWebhookSubscriptionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  public name?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2_048)
  public url?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  public eventTypes?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public description?: string;

  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;
}

export class ListDeliveriesQueryDto {
  @IsOptional()
  @IsString()
  public subscriptionId?: string;

  @IsOptional()
  @IsString()
  public status?: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'RETRYING';

  @IsOptional()
  @IsString()
  public eventType?: string;

  @IsOptional()
  @IsString()
  public cursor?: string;

  @IsOptional()
  public limit?: number;
}
