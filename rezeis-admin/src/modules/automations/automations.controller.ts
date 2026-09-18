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
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional } from 'class-validator';
import type { Request } from 'express';

import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../auth/utils/request-metadata.util';
import { resolveRequestIp } from '../blocked-ips/utils/request-ip.util';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../rbac/guards/rbac.guard';
import { ListExecutionsQueryDto } from './dto/list-executions.dto';
import { UpsertAutomationRuleDto } from './dto/upsert-automation-rule.dto';
import {
  AutomationActionResult,
} from './interfaces/automation-action.interface';
import {
  AutomationRuleInterface,
  ListExecutionsResult,
} from './interfaces/automation-rule.interface';
import { AutomationsService, type AutomationWriteOptions, type RuleReadView } from './automations.service';
import {
  AUTOMATION_ACTION_PERMISSIONS,
  type AutomationActionPermission,
} from './automation-action-permissions';
import { AutomationRuleAccessService } from './services/automation-rule-access.service';
import {
  EVENT_CATALOG_WINDOW_DAYS,
  EventCatalogService,
  type CatalogEvent,
} from './services/event-catalog.service';
import {
  AUTOMATION_ACTION_TYPES,
  AutomationActionType,
  COINCIDENT_EVENT_GROUPS,
} from './automations.constants';

class ToggleRuleDto {
  @IsBoolean()
  isEnabled!: boolean;
}

class RunRuleDto {
  /** What the run is about — for a pop-up, `userId` names the customer. */
  @IsOptional()
  @IsObject()
  triggerData?: Record<string, unknown>;

  /**
   * Queue a `show_hint` again for a customer who already has a delivery of a
   * hint that does not repeat — for this run only.
   *
   * A field of its own and never a key read out of `triggerData`: that object
   * is a payload, and the executor carries this on the run's context where no
   * payload can reach it. A boolean or nothing — a string `"false"` is refused
   * rather than read as a yes.
   */
  @IsOptional()
  @IsBoolean()
  showAgain?: boolean;
}

interface ResourceCatalog {
  readonly actionTypes: readonly AutomationActionType[];
  /**
   * Sets of events that arrive together as one act by one customer.
   *
   * Served rather than duplicated in the SPA because it is domain knowledge
   * about this product's flows, not a UI concern — and because a second copy
   * in the front-end would be a second thing to update when a flow changes.
   */
  readonly coincidentEventGroups: readonly (readonly string[])[];
  /**
   * What each action needs on top of `automations:*`, the very map the save,
   * the switch and «Запустить сейчас» enforce. Served for the reason the
   * groups above are: the editor greys out exactly what the server refuses,
   * and a copy in the SPA would be a second thing to keep in step.
   */
  readonly actionPermissions: Readonly<Record<AutomationActionType, readonly AutomationActionPermission[]>>;
}

interface ManualRunResponse {
  readonly executionId: string;
  readonly status: string;
  readonly actionResults: readonly AutomationActionResult[];
  readonly errorMessage: string | null;
}

@ApiTags('admin/automations')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/automations')
export class AutomationsController {
  public constructor(
    private readonly automationsService: AutomationsService,
    private readonly eventCatalogService: EventCatalogService,
    /**
     * The permission every action in a rule needs, asked of the admin on a
     * save, on switching a rule on and on «Запустить сейчас». `RbacGuard`
     * answers for the route; this answers for what the rule then does as the
     * system — see `automation-action-permissions.ts`.
     */
    private readonly ruleAccess: AutomationRuleAccessService,
  ) {}

  /**
   * What this admin may read of a rule: a `webhook_post` URL whole only when
   * they may edit that action (`RuleReadView`); otherwise its origin.
   */
  private async readView(admin: CurrentAdminInterface): Promise<RuleReadView> {
    return { webhookUrls: await this.ruleAccess.mayReadWebhookUrls(admin) };
  }

  // ── Resource catalog (UI dropdowns) ────────────────────────────────────

  @Get('catalog')
  @RequirePermission('automations', 'view')
  @ApiOperation({ summary: 'Returns the action-type catalog supported by the engine' })
  public catalog(): ResourceCatalog {
    return {
      actionTypes: AUTOMATION_ACTION_TYPES,
      coincidentEventGroups: COINCIDENT_EVENT_GROUPS,
      actionPermissions: AUTOMATION_ACTION_PERMISSIONS,
    };
  }

  /**
   * Every event a rule could be bound to, and whether it has fired HERE.
   *
   * Kept off `catalog` deliberately: that one is a constant this process
   * already holds and answers instantly, while this one groups over the audit
   * log. Folding them together would put a database read on every load of a
   * page that mostly does not need it.
   */
  @Get('events')
  @RequirePermission('automations', 'view')
  @ApiOperation({ summary: 'Event catalogue with per-installation activity' })
  public async events(): Promise<{ events: readonly CatalogEvent[]; windowDays: number }> {
    return {
      events: await this.eventCatalogService.listEvents(),
      windowDays: EVENT_CATALOG_WINDOW_DAYS,
    };
  }

  // ── Rules ──────────────────────────────────────────────────────────────

  @Get('rules')
  @RequirePermission('automations', 'view')
  @ApiOperation({ summary: 'Lists all automation rules with run statistics' })
  public async listRules(@CurrentAdmin() admin: CurrentAdminInterface): Promise<readonly AutomationRuleInterface[]> {
    return this.automationsService.listRules(await this.readView(admin));
  }

  @Get('rules/:id')
  @RequirePermission('automations', 'view')
  @ApiOperation({ summary: 'Returns a single rule with its full configuration' })
  public async getRule(
    @Param('id') id: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<AutomationRuleInterface> {
    return this.automationsService.getRule(id, await this.readView(admin));
  }

  @Post('rules')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('automations', 'create')
  @ApiOperation({ summary: 'Creates a new automation rule' })
  public async createRule(
    @Body() dto: UpsertAutomationRuleDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<AutomationRuleInterface> {
    // Before anything about the rule is judged: a rule this admin may not
    // write is refused as such, whatever else is wrong with it.
    await this.ruleAccess.assertMayUse(admin, dto.actions);
    return this.automationsService.createRule(dto, admin.id, {
      ...writeOptions(admin, req),
      view: await this.readView(admin),
    });
  }

  @Put('rules/:id')
  @RequirePermission('automations', 'edit')
  @ApiOperation({ summary: 'Replaces a rule\'s definition' })
  public async updateRule(
    @Param('id') id: string,
    @Body() dto: UpsertAutomationRuleDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<AutomationRuleInterface> {
    // The actions as they WILL be. An edit that removes an action nobody here
    // may hold is allowed — taking a power out of a rule needs no permission —
    // and one that keeps it needs the permission, because a save restates it.
    await this.ruleAccess.assertMayUse(admin, dto.actions);
    return this.automationsService.updateRule(id, dto, {
      ...writeOptions(admin, req),
      view: await this.readView(admin),
    });
  }

  @Patch('rules/:id/toggle')
  @RequirePermission('automations', 'edit')
  @ApiOperation({ summary: 'Quickly enable / disable a rule' })
  public async toggleRule(
    @Param('id') id: string,
    @Body() dto: ToggleRuleDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<AutomationRuleInterface> {
    return this.automationsService.toggleRule(id, dto.isEnabled, {
      ...writeOptions(admin, req),
      view: await this.readView(admin),
      authorize: (rule) => this.ruleAccess.assertMayUse(admin, rule.actions),
    });
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('automations', 'delete')
  @ApiOperation({ summary: 'Deletes an automation rule and its execution log' })
  public async deleteRule(
    @Param('id') id: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<void> {
    await this.automationsService.deleteRule(id, { audit: writeOptions(admin, req).audit });
  }

  @Post('rules/:id/run')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('automations', 'run')
  @ApiOperation({
    summary: 'Manually fires a rule with an optional triggerData payload',
  })
  @ApiOkResponse({ description: 'Manual execution result' })
  public async runRule(
    @Param('id') id: string,
    @Body() dto: RunRuleDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<ManualRunResponse> {
    const options = writeOptions(admin, req);
    return this.automationsService.runRuleManually({
      ruleId: id,
      adminId: admin.id,
      triggerData: dto.triggerData ?? {},
      showAgain: dto.showAgain === true,
      requestIp: options.requestIp,
      audit: options.audit,
      authorize: (rule) => this.ruleAccess.assertMayUse(admin, rule.actions),
    });
  }

  // ── Executions ─────────────────────────────────────────────────────────

  @Get('executions')
  @RequirePermission('automations', 'view')
  @ApiOperation({ summary: 'Cross-rule execution log (cursor pagination)' })
  public listExecutions(
    @Query() query: ListExecutionsQueryDto,
  ): Promise<ListExecutionsResult> {
    return this.automationsService.listExecutions(null, query);
  }

  @Get('rules/:id/executions')
  @RequirePermission('automations', 'view')
  @ApiOperation({ summary: 'Per-rule execution log' })
  public listRuleExecutions(
    @Param('id') id: string,
    @Query() query: ListExecutionsQueryDto,
  ): Promise<ListExecutionsResult> {
    return this.automationsService.listExecutions(id, query);
  }
}

/**
 * Who is writing and from where: the audit row's actor and request, and the
 * address a `block_ip` in the rule must not cover — resolved by the very
 * function `BlockedIpGuard` uses, so the two cannot disagree about who the
 * caller is.
 */
function writeOptions(
  admin: CurrentAdminInterface,
  req: Request,
): AutomationWriteOptions & { readonly audit: NonNullable<AutomationWriteOptions['audit']> } {
  return {
    audit: { actorId: admin.id, requestMetadata: extractRequestMetadata(req) },
    requestIp: resolveRequestIp(req),
  };
}
