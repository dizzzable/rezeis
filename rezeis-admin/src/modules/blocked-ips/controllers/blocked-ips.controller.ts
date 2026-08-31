import {
  BadRequestException,
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
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
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
import { ipMatchesEntry, parseAddressOrCidr } from '../utils/cidr-match';
import { resolveRequestIp } from '../utils/request-ip.util';

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
  // `async`, so the self-lockout refusal REJECTS rather than throwing
  // synchronously out of a method whose type says it returns a promise. Nest
  // handles both, but any other caller doing `.catch()` would miss a sync throw
  // entirely — and this one refuses a destructive action.
  public async create(
    @Body() dto: CreateBlockedIpDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<BlockedIpDto> {
    this.refuseSelfLockout(dto.address, req);
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

  /**
   * Refuses an entry that would lock the operator out of the panel.
   *
   * ── Why this is a hard refusal and not a warning ──────────────────────────
   *
   * `BlockedIpGuard` is registered as the FIRST global guard: it runs before
   * the admin IP allowlist and before the JWT guard. So a blocked address is
   * turned away before anything can recognise it as an operator's — being on
   * the allowlist does not save you, and neither does being signed in. The way
   * back is an UPDATE against the database, which is not a thing an operator
   * can do from the panel they just locked themselves out of.
   *
   * The mistake is ordinary, not exotic: an operator blocking a pest who shares
   * their office NAT, or pasting a /24 to stop a scan without noticing they are
   * inside it.
   *
   * ── Matched, not compared ─────────────────────────────────────────────────
   *
   * The entry may be a CIDR, so string equality would miss every case that
   * matters. This asks the same question the guard asks — does the caller's
   * address fall inside this entry — using the same matcher and the same
   * address resolution, so the two cannot disagree.
   *
   * An address we cannot resolve is NOT treated as a match: refusing every
   * entry because the caller arrived over a transport with no derivable address
   * would break the feature to protect against a case that cannot happen (the
   * guard fails open on exactly the same input).
   */
  private refuseSelfLockout(address: string, req: Request): void {
    const mine = resolveRequestIp(req);
    if (mine === null) return;
    const entry = parseAddressOrCidr(address);
    // An unparseable address is the service's error to report, not this one's.
    if (entry === null) return;
    if (!ipMatchesEntry(mine, entry)) return;
    throw new BadRequestException({
      code: 'SELF_LOCKOUT_REFUSED',
      message:
        `This entry covers your own address (${mine}). The IP blocklist is checked ` +
        `before the admin allowlist and before sign-in, so adding it would lock you ` +
        `out of the panel with no way back except the database.`,
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
