import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';

import { CurrentAdmin } from '../../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../../auth/utils/request-metadata.util';
import {
  RequireAllPermissions,
  RequirePermission,
} from '../../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../../rbac/guards/rbac.guard';
import {
  GetPlanMigrationRunQueryDto,
  ListPlanMigrationSubscriptionsQueryDto,
  PreviewPlanMigrationDto,
  RetryPlanMigrationDto,
  StartPlanMigrationDto,
} from '../dto/plan-migration.dto';
import {
  PlanMigrationPreview,
  PlanMigrationQueryService,
  PlanMigrationRunView,
  PlanMigrationSubscriptionsPage,
} from '../plan-migration-query.service';
import { PlanMigrationRunnerService } from '../plan-migration-runner.service';

/**
 * MOVING SUBSCRIPTIONS OFF A PLAN BEFORE IT IS DELETED — the delete dialog's
 * routes, on the `admin/plans` surface.
 *
 * A controller of its own rather than more methods on `AdminPlansController`,
 * with the same guards and the same base path, so the wire contract is the one
 * the dialog calls. Its dependencies are its own module's
 * (`PlanMigrationsModule`), which keeps `PlansModule`'s controller list — read
 * straight off the module by `admin-plans-stats.http.spec.ts` — unchanged.
 *
 * ── Permissions ──────────────────────────────────────────────────────────────
 *
 * Every route answers or acts on SUBSCRIPTIONS and user identities, and exists
 * only to serve a plan delete, so each needs both halves: `plans:delete` AND
 * `subscriptions:view` to read, `plans:delete` AND `subscriptions:edit` to move.
 * `RequireAllPermissions` on every handler, because `RbacGuard` resolves the
 * metadata with `getAllAndOverride` — a handler decorator REPLACES the class's.
 * The class-level `plans:delete` is the floor a future handler added without a
 * decorator falls to, never below; by default only the superadmin role holds
 * both halves of any pair here.
 *
 * No route here has a literal segment where `AdminPlansController` has a
 * parameter at the same depth, so neither controller can shadow the other
 * (`test/route-shadowing.spec.ts`).
 */
@Controller('admin/plans')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('plans', 'delete')
export class AdminPlanMigrationsController {
  public constructor(
    private readonly queryService: PlanMigrationQueryService,
    private readonly runnerService: PlanMigrationRunnerService,
  ) {}

  /** Subscriptions on the plan, for the dialog's list. 404 for an unknown or deleted plan. */
  @Get(':planId/subscriptions')
  @RequireAllPermissions(['plans', 'delete'], ['subscriptions', 'view'])
  public async listSubscriptions(
    @Param('planId') planId: string,
    @Query() query: ListPlanMigrationSubscriptionsQueryDto,
  ): Promise<PlanMigrationSubscriptionsPage> {
    return this.queryService.listSubscriptions(planId, query);
  }

  /** «было → станет» for an assignment, computed by the move's own function. No writes. */
  @Post(':planId/migrations/preview')
  @HttpCode(HttpStatus.OK)
  @RequireAllPermissions(['plans', 'delete'], ['subscriptions', 'view'])
  public async preview(
    @Param('planId') planId: string,
    @Body() body: PreviewPlanMigrationDto,
  ): Promise<PlanMigrationPreview> {
    return this.queryService.preview(planId, body);
  }

  /** Creates the run and its items, queues the work, answers at once. */
  @Post(':planId/migrations')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireAllPermissions(['plans', 'delete'], ['subscriptions', 'edit'])
  public async startMigration(
    @Param('planId') planId: string,
    @Body() body: StartPlanMigrationDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<{ readonly runId: string; readonly totalItems: number }> {
    return this.runnerService.startRun(planId, body, {
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }

  /**
   * The plan's QUEUED or RUNNING run, or `{ runId: null }` — also for a plan
   * that is missing or already deleted, never 404.
   *
   * DECLARED BEFORE `:planId/migrations/:runId`, and that is load-bearing:
   * Express answers from the first route registered for a method, Nest
   * registers a controller's routes in declaration order, and `:runId` matches
   * the segment `current`. Below it, this route would be unreachable — a lookup
   * of a run whose id is "current", answered 404. `test/route-shadowing.spec.ts`
   * compares only literal paths against parameterised ones, and both of these
   * carry `:planId`, so `plan-migration.controller.spec.ts` checks this pair
   * (and every other pair on this surface) itself, and over HTTP.
   */
  @Get(':planId/migrations/current')
  @RequireAllPermissions(['plans', 'delete'], ['subscriptions', 'view'])
  public async getCurrentRun(
    @Param('planId') planId: string,
  ): Promise<{ readonly runId: string | null }> {
    return this.queryService.getCurrentRun(planId);
  }

  /** A run's progress and problems, for the dialog's poll. */
  @Get(':planId/migrations/:runId')
  @RequireAllPermissions(['plans', 'delete'], ['subscriptions', 'view'])
  public async getRun(
    @Param('planId') planId: string,
    @Param('runId') runId: string,
    @Query() query: GetPlanMigrationRunQueryDto,
  ): Promise<PlanMigrationRunView> {
    return this.queryService.getRun(planId, runId, query.problemsCursor);
  }

  /**
   * «Повторить для неудавшихся» (`failed`) and «Повторить синхронизацию» (`sync`).
   * The moves a retry causes are audited under THIS admin, not the run's creator.
   */
  @Post(':planId/migrations/:runId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireAllPermissions(['plans', 'delete'], ['subscriptions', 'edit'])
  public async retry(
    @Param('planId') planId: string,
    @Param('runId') runId: string,
    @Body() body: RetryPlanMigrationDto,
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Req() request: Request,
  ): Promise<{ readonly runId: string }> {
    return this.runnerService.retry(planId, runId, body.scope, {
      currentAdmin,
      requestMetadata: extractRequestMetadata(request),
    });
  }
}
