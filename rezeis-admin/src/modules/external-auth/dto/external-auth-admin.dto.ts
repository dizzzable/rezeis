import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { DisposableEmailMode } from '../interfaces/external-auth.interface';

const DISPOSABLE_MODES: readonly DisposableEmailMode[] = ['off', 'blocklist', 'blocklist_mx', 'allowlist'];

/** Update one external provider's configuration (admin). */
export class UpdateExternalProviderDto {
  @IsOptional()
  @IsBoolean()
  public isEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  public clientId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  public clientSecret?: string | null;

  @IsOptional()
  @IsBoolean()
  public usePkce?: boolean;

  @IsOptional()
  @IsBoolean()
  public useOidc?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  public scopes?: string | null;
}

/** Update the disposable-email / external-auth policy (admin). */
export class UpdateDisposablePolicyDto {
  @IsOptional()
  @IsIn(DISPOSABLE_MODES as readonly string[])
  public mode?: DisposableEmailMode;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(253, { each: true })
  public customBlocklist?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(253, { each: true })
  public allowlist?: string[];

  @IsOptional()
  @IsBoolean()
  public gateProvidersByEmailModule?: boolean;
}
