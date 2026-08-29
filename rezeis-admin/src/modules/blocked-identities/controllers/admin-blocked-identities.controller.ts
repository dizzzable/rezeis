import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BlockedIdentity } from '@prisma/client';
import type { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  AddBlockedIdentitiesDto,
  ListBlockedIdentitiesDto,
} from '../dto/blocked-identity.dto';
import { BlockedIdentityService } from '../services/blocked-identity.service';

/**
 * Identity blocklist — the pre-emptive half of banning.
 *
 * `POST /admin/users/:telegramId/block` can only refuse somebody who already
 * exists. This surface takes a LIST of identities and refuses them whether or
 * not an account has ever been created, which is the case an operator actually
 * has: a set of ids handed over from another install, a raid, a name they never
 * want to see sign up.
 *
 * Permissions mirror `blocked_ips`, the sibling list, so an operator trusted
 * with one blocklist is not surprised by the other.
 */
@ApiTags('admin/blocked-identities')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/blocked-identities')
export class AdminBlockedIdentitiesController {
  public constructor(
    private readonly blockedIdentityService: BlockedIdentityService,
    private readonly prismaService: PrismaService,
  ) {}

  @Get()
  @RequirePermission('blocked_identities', 'view')
  @ApiOperation({ summary: 'Lists blocklist entries' })
  public async list(
    @Query() query: ListBlockedIdentitiesDto,
  ): Promise<{ readonly items: readonly BlockedIdentity[] }> {
    const items = await this.blockedIdentityService.list({
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.search === undefined ? {} : { search: query.search }),
    });
    return { items };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('blocked_identities', 'create')
  @ApiOperation({ summary: 'Adds one or many identities to the blocklist' })
  public async add(
    @Body() dto: AddBlockedIdentitiesDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<{
    readonly added: number;
    readonly duplicates: readonly string[];
    readonly rejected: ReadonlyArray<{ readonly value: string; readonly reason: string }>;
  }> {
    const result = await this.blockedIdentityService.addMany({
      kind: dto.kind,
      values: dto.values,
      reason: dto.reason ?? null,
      expiresAt: dto.expiresAt ?? null,
      source: 'manual',
      createdById: admin.id,
    });

    // 200, not 201, and a per-row report rather than the created rows: a paste
    // with three typos in two hundred lines must not fail as a unit, and the
    // operator has to be able to see WHICH three.
    //
    // Audited like every other mutating admin route. The count is recorded
    // rather than the values — a blocklist entry is about a person, and the
    // audit log is read by more people than the blocklist is.
    await this.audit(admin, req, {
      kind: dto.kind,
      added: result.added.length,
      // Kept apart from `added` in the AUDIT, because the two are different
      // acts: one listed somebody new, the other took a row a ban had created
      // automatically and made it an operator's own decision. The second is the
      // one worth being able to find later.
      promoted: result.promoted.length,
      duplicates: result.duplicates.length,
      rejected: result.rejected.length,
    });

    // Promotions count as ADDED here, unlike in the audit above. The operator's
    // question at this screen is "did my paste take effect?", and for a row
    // that was cascade a moment ago and is now theirs the answer is yes.
    // Reporting it as neither added nor duplicate — which is what it was before
    // promotion existed — showed a paste that changed something as a paste that
    // did nothing at all.
    return {
      added: result.added.length + result.promoted.length,
      duplicates: result.duplicates,
      rejected: result.rejected,
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('blocked_identities', 'delete')
  @ApiOperation({ summary: 'Removes an entry from the blocklist' })
  public async remove(
    @Param('id') id: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<void> {
    await this.blockedIdentityService.remove(id);
    await this.audit(admin, req, { removedId: id });
  }

  private async audit(
    admin: CurrentAdminInterface,
    req: Request,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const requestMetadata = extractRequestMetadata(req);
    await this.prismaService.adminAuditLog
      .create({
        data: {
          adminUserId: admin.id,
          action: 'blocked_identity.changed',
          ipAddress: requestMetadata.remoteAddress,
          userAgent: requestMetadata.userAgent,
          metadata: metadata as never,
        },
      })
      // Best-effort: losing the audit row must not undo a block the operator
      // just made. The block is the thing with a security consequence.
      .catch(() => undefined);
  }
}
