import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { normalizeCode } from '../utils/code-normalizer.util';

/**
 * Public-facing activation payload accepted from both the admin operator UI
 * and the public ruid edge. The DTO normalizes the code on the wire to keep
 * service-layer comparisons consistent.
 */
export class ActivatePromocodeDto {
  @Transform(({ value }: { readonly value: unknown }): unknown =>
    typeof value === 'string' ? normalizeCode(value) : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  public code!: string;

  @IsOptional()
  @IsString()
  public subscriptionId?: string;

  @IsOptional()
  @IsBoolean()
  public confirmCreateNew?: boolean;
}
