import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { RbacService } from '../../rbac/services/rbac.service';
import {
  ALL_SECTIONS_LITERAL,
  ConfigExportQueryDto,
  ConfigImportDto,
} from '../dto/config-import.dto';
import {
  ALL_SECTIONS,
  ConfigExportPayloadInterface,
  ConfigExportSection,
  ConfigExportService,
  ConfigPortabilityActor,
} from '../services/config-export.service';
import { ConfigImportService } from '../services/config-import.service';

const SECTION_SET = new Set<string>(ALL_SECTIONS_LITERAL);

/**
 * The grant a caller needs ON TOP of `config_portability:export` before the
 * export will keep `webhooks.secret` in the clear.
 *
 * Why this needs a server-side gate at all
 * ────────────────────────────────────────
 * The SPA gates the toggle, and `web/src/features/rbac/permission-gate.tsx`
 * says of itself, correctly, that it is "a UX hint, not a security boundary".
 * Until now the endpoint enforced only `config_portability:export`, so an admin
 * holding that alone could send `?includeWebhookSecrets=true` by hand and read
 * every live signing secret. A boundary that exists only in the client is not
 * one.
 *
 * Why `webhooks:edit`, checked and not assumed
 * ────────────────────────────────────────────
 * This flag is the ONLY way in the panel to read an EXISTING webhook secret.
 * Verified against the code rather than taken on trust: list responses hardcode
 * `secret: null` (`webhook-subscriptions.service.ts:17-18`), and the two
 * endpoints that return plaintext — `POST subscriptions` and
 * `POST subscriptions/:id/regenerate-secret` — both MINT a new value. There is
 * no read path.
 *
 * `webhooks:edit` is the token that already governs the closest existing power:
 * `rbac.resources.ts` describes it as covering "updating, regenerating secrets,
 * testing, and replaying a delivery", and `regenerate-secret` is gated on it.
 * An admin holding `webhooks:edit` can therefore already obtain a working
 * secret for any subscription — by rotating it. So this flag grants no power
 * that token does not already imply.
 *
 * The one difference, stated rather than glossed: rotating is LOUD (the old
 * secret stops validating and receivers break until reconfigured) while reading
 * is SILENT. What closes that gap is the audit row — `recordExport` already
 * writes `includeWebhookSecrets` into its metadata, so a silent read is still a
 * recorded one.
 *
 * NOT `webhooks:create` as well, even though the IMPORT side demands
 * `['webhooks:create', 'webhooks:edit']`. That pair is about WRITING: an admin
 * who may add a subscription but not edit one must not overwrite the existing
 * set. Reading is a different power, `webhooks:create` adds nothing to it (a
 * new subscription's new secret says nothing about an existing one), and
 * demanding it would refuse the legitimate promote-to-a-new-environment
 * workflow this flag exists for.
 */
const WEBHOOK_SECRET_EXPORT_PERMISSION = 'webhooks:edit';

/**
 * The actor for the audit row, taken from the authenticated principal and the
 * socket — never from anything the caller can type.
 */
function resolveActor(
  admin: CurrentAdminInterface,
  request: Request,
): ConfigPortabilityActor {
  const metadata = extractRequestMetadata(request);
  return {
    adminId: admin.id,
    ipAddress: metadata.remoteAddress,
    userAgent: metadata.userAgent,
    requestId: metadata.requestId,
  };
}

@ApiTags('admin/config')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/config')
export class AdminConfigPortabilityController {
  public constructor(
    private readonly exportService: ConfigExportService,
    private readonly importService: ConfigImportService,
    private readonly rbacService: RbacService,
  ) {}

  @Get('sections')
  @RequirePermission('config_portability', 'view')
  @ApiOperation({ summary: 'Lists the canonical export sections' })
  public listSections() {
    return { sections: ALL_SECTIONS };
  }

  @Get('export')
  @RequirePermission('config_portability', 'export')
  @ApiOperation({
    summary:
      'Returns the JSON export payload for the requested sections '
      + '(secrets redacted; ?includeWebhookSecrets=true to keep webhook signing secrets)',
  })
  public async exportConfig(
    @Query() query: ConfigExportQueryDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() request: Request,
  ) {
    const sections = normaliseSections(query.sections);
    const includeWebhookSecrets = query.includeWebhookSecrets === true;
    // Resolved ONLY when the caller actually asks for secrets. An ordinary
    // export must be untouched by this — same response, and not even the extra
    // round trip to resolve grants. A gate that taxes the common path is a
    // different kind of outage.
    if (includeWebhookSecrets) {
      await this.assertMayExportWebhookSecrets(admin);
    }
    return this.exportService.exportConfig(sections, {
      includeWebhookSecrets,
      actor: resolveActor(admin, request),
    });
  }

  /**
   * Refuses outright rather than silently downgrading to a redacted export.
   *
   * Downgrading was the tempting option and it is the wrong one, for the reason
   * this module already wrote down about a different failure: `exportConfig`
   * refuses to emit a partial file because that "produced a file that looks
   * complete and restores to nothing". A silent downgrade here is the same
   * shape — the operator promotes the config, every receiver silently fails
   * signature validation afterwards, and nothing at any point said so. Being
   * told now costs one round trip and un-ticking a checkbox.
   *
   * `ForbiddenException` to match `RbacGuard`, which is what a caller who fails
   * a permission check already gets from this API.
   */
  private async assertMayExportWebhookSecrets(admin: CurrentAdminInterface): Promise<void> {
    const effective = await this.rbacService.getEffectivePermissions({
      id: admin.id,
      role: admin.role,
      rbacRoleId: admin.rbacRoleId,
    });
    const held = new Set(effective.map((p) => `${p.resource}:${p.action}`));
    if (!held.has(WEBHOOK_SECRET_EXPORT_PERMISSION)) {
      throw new ForbiddenException(
        `Exporting webhook signing secrets requires ${WEBHOOK_SECRET_EXPORT_PERMISSION}. `
          + 'Re-run the export without that option to get a redacted file.',
      );
    }
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('config_portability', 'import')
  @ApiOperation({ summary: 'Imports a previously-exported configuration JSON' })
  public async importConfig(
    @Body() dto: ConfigImportDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() request: Request,
  ) {
    const sections = normaliseSections(dto.sections);
    // Resolve the importer's effective grants so the service can enforce
    // the RBAC-escalation invariants (gate roles/permissions behind
    // rbac_roles:edit and forbid importing grants the admin lacks).
    const effective = await this.rbacService.getEffectivePermissions({
      id: admin.id,
      role: admin.role,
      rbacRoleId: admin.rbacRoleId,
    });
    const importerPermissions = new Set(
      effective.map((p) => `${p.resource}:${p.action}`),
    );
    return this.importService.importConfig({
      payload: dto.payload as unknown as ConfigExportPayloadInterface,
      sections,
      strategy: dto.strategy,
      dryRun: dto.dryRun,
      importerPermissions,
      actor: resolveActor(admin, request),
    });
  }
}

function normaliseSections(input?: readonly string[]): readonly ConfigExportSection[] | null {
  if (!input || input.length === 0) return null;
  const filtered = input.filter((value) => SECTION_SET.has(value));
  if (filtered.length === 0) {
    throw new BadRequestException('No valid sections supplied');
  }
  return filtered as readonly ConfigExportSection[];
}
