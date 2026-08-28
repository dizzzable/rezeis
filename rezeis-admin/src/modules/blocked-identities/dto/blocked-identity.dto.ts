import { BlockedIdentityKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Adding to the identity blocklist.
 *
 * The body takes an ARRAY even for one entry. The operator need this feature
 * exists for is "here is a list of ids to keep out", and a single-value
 * endpoint turns a paste of two hundred lines into two hundred requests with
 * two hundred chances to stop halfway.
 */
export class AddBlockedIdentitiesDto {
  @IsEnum(BlockedIdentityKind)
  public readonly kind!: BlockedIdentityKind;

  /**
   * Raw values, exactly as pasted. Normalisation happens on the server so the
   * stored form is decided in one place — see `normalise-identity.util.ts`.
   *
   * The cap is a paste-accident guard, not a policy: an operator who really has
   * more than this can paste twice, whereas a whole log file pasted by mistake
   * should be refused before it becomes five thousand rows.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1_000)
  @IsString({ each: true })
  @MaxLength(254, { each: true })
  public readonly values!: readonly string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly reason?: string;

  /** `null`/absent means permanent, matching `BlockedIp`. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  public readonly expiresAt?: Date;
}

export class ListBlockedIdentitiesDto {
  @IsOptional()
  @IsEnum(BlockedIdentityKind)
  public readonly kind?: BlockedIdentityKind;

  @IsOptional()
  @IsString()
  @MaxLength(254)
  public readonly search?: string;
}
