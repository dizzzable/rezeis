import { IsArray, IsHexColor, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * One custom icon in the operator's library. `id` is assigned by the backend
 * on creation; the client echoes it back on updates.
 */
export class CustomIconDto {
  @IsString()
  @MaxLength(64)
  public id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  public name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(8192)
  public url!: string;

  @IsOptional()
  @IsHexColor()
  public color?: string | null;
}

/**
 * Full-list replacement of the custom-icon library. The panel sends the whole
 * array on every save (add / rename / recolour / reorder / delete), mirroring
 * how the branding sections persist.
 */
export class UpdateCustomIconsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomIconDto)
  public icons!: CustomIconDto[];
}
