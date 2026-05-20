import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';

/**
 * Input DTO for creating / replacing a role.
 *
 * Both create and update use the same shape: the controller distinguishes
 * by route. `name` is immutable on update and is therefore always honoured
 * from the URL parameter, never the body, on `PUT`.
 */
export class AdminPermissionInputDto {
  @IsString()
  @Length(1, 64)
  resource!: string;

  @IsString()
  @Length(1, 32)
  action!: string;
}

export class CreateAdminRoleDto {
  @IsString()
  @Length(2, 32)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'name must be lowercase alphanumeric with optional underscores (e.g. ops_lead)',
  })
  name!: string;

  @IsString()
  @Length(2, 64)
  displayName!: string;

  @IsOptional()
  @IsString()
  @Length(0, 256)
  description?: string;

  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => AdminPermissionInputDto)
  permissions!: AdminPermissionInputDto[];
}

export class UpdateAdminRoleDto {
  @IsString()
  @Length(2, 64)
  displayName!: string;

  @IsOptional()
  @IsString()
  @Length(0, 256)
  description?: string;

  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => AdminPermissionInputDto)
  permissions!: AdminPermissionInputDto[];
}
