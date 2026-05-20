import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  BlockedIpDto,
  BlockedIpService,
} from '../services/blocked-ip.service';

class ListBlockedIpsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

class CreateBlockedIpDto {
  @IsString()
  @Length(1, 64)
  address!: string;

  @IsOptional()
  @IsString()
  @Length(0, 256)
  reason?: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

class UpdateBlockedIpDto {
  @IsOptional()
  @IsString()
  @Length(0, 256)
  reason?: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;
}

interface ListBlockedIpsResponse {
  readonly items: readonly BlockedIpDto[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

@ApiTags('admin/blocked-ips')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/blocked-ips')
export class BlockedIpsController {
  public constructor(private readonly blockedIpService: BlockedIpService) {}

  @Get()
  @RequirePermission('blocked_ips', 'view')
  @ApiOperation({ summary: 'Lists blocked IP / CIDR entries' })
  @ApiOkResponse({ description: 'Paginated blocked IP list' })
  public list(@Query() query: ListBlockedIpsQueryDto): Promise<ListBlockedIpsResponse> {
    return this.blockedIpService.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('blocked_ips', 'create')
  @ApiOperation({ summary: 'Adds an IP / CIDR to the blocklist' })
  public create(
    @Body() dto: CreateBlockedIpDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<BlockedIpDto> {
    return this.blockedIpService.create({
      address: dto.address,
      reason: dto.reason ?? null,
      source: 'manual',
      createdById: admin.id,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });
  }

  @Patch(':id')
  @RequirePermission('blocked_ips', 'create')
  @ApiOperation({ summary: 'Updates the reason or expiry of an existing entry' })
  public update(
    @Param('id') id: string,
    @Body() dto: UpdateBlockedIpDto,
  ): Promise<BlockedIpDto> {
    return this.blockedIpService.update(id, {
      reason: dto.reason !== undefined ? dto.reason : undefined,
      expiresAt:
        dto.expiresAt === undefined
          ? undefined
          : dto.expiresAt === null
            ? null
            : new Date(dto.expiresAt),
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('blocked_ips', 'delete')
  @ApiOperation({ summary: 'Removes an entry from the blocklist' })
  public async delete(@Param('id') id: string): Promise<void> {
    await this.blockedIpService.delete(id);
  }
}
