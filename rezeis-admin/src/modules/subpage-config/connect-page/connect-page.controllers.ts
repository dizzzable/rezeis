import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { ReiwaCacheInvalidatorService } from '../../bot-config/services/reiwa-cache-invalidator.service';
import { ConnectPageService } from './connect-page.service';
import type { ConnectPageConfig, ConnectPageIssue } from './connect-page.schema';

/**
 * The catalog behind the cabinet's connect screen, from both sides.
 *
 * Two controllers in one file because they are two views of one thing and
 * splitting them across files hides that the admin write is what the internal
 * read serves. They do NOT share a guard: the admin side is an operator with a
 * session and an RBAC permission, the internal side is the cabinet with a
 * service token, and conflating those is how a customer-facing endpoint ends up
 * behind an operator login or the reverse.
 */
@ApiTags('admin/connect-page')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('subpage_config', 'view')
@Controller('admin/connect-page')
export class AdminConnectPageController {
  public constructor(
    private readonly connectPage: ConnectPageService,
    private readonly reiwaCache: ReiwaCacheInvalidatorService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Read the connect-screen catalog' })
  public async get(): Promise<{
    config: ConnectPageConfig;
    stored: boolean;
    corrupted: string | null;
  }> {
    return this.connectPage.readState();
  }

  /**
   * Check without saving.
   *
   * A POST rather than a GET because the body is the whole catalog, and it is
   * not idempotent in the sense that matters here — it is a question about a
   * value the server does not hold.
   */
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subpage_config', 'edit')
  @ApiOperation({ summary: 'Validate a draft catalog without storing it' })
  public validate(@Body() body: unknown): {
    ok: boolean;
    issues: readonly ConnectPageIssue[];
    cleanedIcons: Readonly<Record<string, readonly string[]>>;
  } {
    return this.connectPage.dryRun(unwrap(body));
  }

  /**
   * The switch, on its own.
   *
   * Separate from the catalog PUT because flicking it must not be an edit of
   * the catalog: sending the whole config back to change one boolean froze the
   * built-in default into the database on the first flick, and let a stale
   * editor draft turn the screen off again on the next save.
   */
  @Put('enabled')
  @RequirePermission('subpage_config', 'edit')
  @ApiOperation({ summary: 'Turn the cabinet connect screen on or off' })
  public async setEnabled(@Body() body: unknown): Promise<{ enabled: boolean }> {
    const raw = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const enabled = await this.connectPage.setEnabled(raw['enabled'] === true);
    void this.reiwaCache.invalidateConnectPage('connect screen toggled');
    return { enabled };
  }

  @Put()
  @RequirePermission('subpage_config', 'edit')
  @ApiOperation({ summary: 'Replace the connect-screen catalog' })
  public async replace(@Body() body: unknown): Promise<{
    config: ConnectPageConfig;
    cleanedIcons: Readonly<Record<string, readonly string[]>>;
  }> {
    const result = await this.connectPage.replaceConfig(unwrap(body));
    // After the write, never before: an invalidate sent on a save that then
    // fails would have the cabinet re-fetch the OLD config and cache it fresh
    // for another TTL, which looks exactly like the save not working.
    void this.reiwaCache.invalidateConnectPage('connect-page catalog saved');
    return result;
  }
}

@ApiTags('internal/connect-page')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/connect-page')
export class InternalConnectPageController {
  public constructor(private readonly connectPage: ConnectPageService) {}

  /**
   * What the cabinet renders.
   *
   * The whole catalog in one response, cached on the cabinet side: it is small,
   * it is the same for everybody, and the alternative — a request per platform
   * — would make the screen wait on the network to answer a question it can
   * already answer from the device it is running on.
   */
  @Get('effective')
  @ApiOperation({ summary: 'Connect-screen catalog consumed by the cabinet' })
  public async getEffective(): Promise<ConnectPageConfig> {
    return this.connectPage.getEffectiveConfig();
  }
}

/** The editor posts `{ config }`; a direct caller may post the config itself. */
function unwrap(body: unknown): unknown {
  return body !== null && typeof body === 'object' && 'config' in body
    ? (body as { config: unknown }).config
    : body;
}
