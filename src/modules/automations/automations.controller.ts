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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional } from 'class-validator';

import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../auth/interfaces/current-admin.interface';
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
import { AutomationsService } from './automations.service';
import {
  AUTOMATION_ACTION_TYPES,
  AutomationActionType,
} from './automations.constants';

class ToggleRuleDto {
  @IsBoolean()
  isEnabled!: boolean;
}

class RunRuleDto {
  @IsOptional()
  @IsObject()
  triggerData?: Record<string, unknown>;
}

interface ResourceCatalog {
  readonly actionTypes: readonly AutomationActionType[];
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
  public constructor(private readonly automationsService: AutomationsService) {}

  // ── Resource catalog (UI dropdowns) ────────────────────────────────────

  @Get('catalog')
  @RequirePermission('automations', 'view')
  @ApiOperation({ summary: 'Returns the action-type catalog supported by the engine' })
  public catalog(): ResourceCatalog {
    return { actionTypes: AUTOMATION_ACTION_TYPES };
  }

  // ── Rules ──────────────────────────────────────────────────────────────

  @Get('rules')
  @RequirePermission('automations', 'view')
  @ApiOperation({ summary: 'Lists all automation rules with run statistics' })
  public listRules(): Promise<readonly AutomationRuleInterface[]> {
    return this.automationsService.listRules();
  }

  @Get('rules/:id')
  @RequirePermission('automations', 'view')
  @ApiOperation({ summary: 'Returns a single rule with its full configuration' })
  public getRule(@Param('id') id: string): Promise<AutomationRuleInterface> {
    return this.automationsService.getRule(id);
  }

  @Post('rules')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('automations', 'create')
  @ApiOperation({ summary: 'Creates a new automation rule' })
  public createRule(
    @Body() dto: UpsertAutomationRuleDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<AutomationRuleInterface> {
    return this.automationsService.createRule(dto, admin.id);
  }

  @Put('rules/:id')
  @RequirePermission('automations', 'edit')
  @ApiOperation({ summary: 'Replaces a rule\'s definition' })
  public updateRule(
    @Param('id') id: string,
    @Body() dto: UpsertAutomationRuleDto,
  ): Promise<AutomationRuleInterface> {
    return this.automationsService.updateRule(id, dto);
  }

  @Patch('rules/:id/toggle')
  @RequirePermission('automations', 'edit')
  @ApiOperation({ summary: 'Quickly enable / disable a rule' })
  public toggleRule(
    @Param('id') id: string,
    @Body() dto: ToggleRuleDto,
  ): Promise<AutomationRuleInterface> {
    return this.automationsService.toggleRule(id, dto.isEnabled);
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('automations', 'delete')
  @ApiOperation({ summary: 'Deletes an automation rule and its execution log' })
  public async deleteRule(@Param('id') id: string): Promise<void> {
    await this.automationsService.deleteRule(id);
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
  ): Promise<ManualRunResponse> {
    return this.automationsService.runRuleManually({
      ruleId: id,
      adminId: admin.id,
      triggerData: dto.triggerData ?? {},
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
