import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Beginning an enrollment mints a NEW second factor, so it is a
 * privilege-raising act and demands the one credential a hijacked session does
 * not carry. `password` is optional on the DTO — not because it is optional in
 * effect, but so the service can answer an omitted one with the same
 * `factor`-carrying 401 the passkey enrolment uses, instead of a validation
 * error the SPA cannot turn into a prompt.
 */
export class TwoFactorEnrollDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public password?: string;
}

export class TwoFactorVerifyDto {
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  public code!: string;
}

export class TwoFactorDisableDto {
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  public code!: string;
}

export class CreateAllowlistEntryDto {
  @IsString()
  @MinLength(7)
  @MaxLength(64)
  public address!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public label?: string;

  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;
}

export class UpdateAllowlistEntryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public label?: string;

  @IsOptional()
  @IsBoolean()
  public isActive?: boolean;
}
