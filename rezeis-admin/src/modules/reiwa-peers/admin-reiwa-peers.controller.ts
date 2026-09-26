import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../rbac/guards/rbac.guard';
import { ReiwaPeerRegistry, type ReiwaPeersSnapshot } from './reiwa-peer-registry.service';

/**
 * AdminReiwaPeersController
 * ═════════════════════════
 * `GET /api/admin/reiwa-peers` — which Reiwa cabinet this panel is talking to:
 * the site-and-API process and the bot, their versions, when each was last
 * heard from, how the panel knows (declared, or the evidence a silent one
 * leaves), and what does not work until the cabinet is updated. The block at
 * the top of «WEB Reiwa» reads it, beside the cabinet's other delivery notices.
 * Read-only; the same permission as reading the branding.
 */
@ApiTags('admin/reiwa-peers')
@Controller('admin/reiwa-peers')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('settings', 'view')
export class AdminReiwaPeersController {
  public constructor(private readonly peers: ReiwaPeerRegistry) {}

  @Get()
  @ApiOperation({ summary: 'The connected Reiwa cabinet: versions, last contact, what it cannot do yet' })
  public get(): Promise<ReiwaPeersSnapshot> {
    return this.peers.snapshot();
  }
}
