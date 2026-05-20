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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { WebhookDeliveryStatus } from '@prisma/client';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import {
  CreateWebhookSubscriptionDto,
  ListDeliveriesQueryDto,
  UpdateWebhookSubscriptionDto,
} from '../dto/webhook-subscription.dto';
import { WebhookDeliveriesService } from '../services/webhook-deliveries.service';
import { WebhookDispatcherService } from '../services/webhook-dispatcher.service';
import { WebhookSubscriptionsService } from '../services/webhook-subscriptions.service';
import { WEBHOOK_EVENT_CATALOG } from '../webhooks.constants';

/**
 * Admin-facing API for managing outgoing webhook subscriptions, viewing
 * delivery history, and replaying / testing payloads.
 *
 * Permission model
 *   Tied to the `webhooks` resource (auto-registered by the RBAC seeder
 *   on startup — see `rbac.resources.ts`).
 */
@ApiTags('admin/webhooks')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/webhooks')
export class AdminWebhooksController {
  public constructor(
    private readonly subscriptionsService: WebhookSubscriptionsService,
    private readonly deliveriesService: WebhookDeliveriesService,
    private readonly dispatcherService: WebhookDispatcherService,
  ) {}

  // ── Catalog ─────────────────────────────────────────────────────────────

  @Get('event-catalog')
  @RequirePermission('webhooks', 'view')
  @ApiOperation({ summary: 'Returns the canonical list of event types' })
  public listEventCatalog() {
    return { events: WEBHOOK_EVENT_CATALOG };
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  @Get('subscriptions')
  @RequirePermission('webhooks', 'view')
  @ApiOperation({ summary: 'Lists webhook subscriptions' })
  public async listSubscriptions() {
    const items = await this.subscriptionsService.list();
    return { items, total: items.length };
  }

  @Get('subscriptions/:id')
  @RequirePermission('webhooks', 'view')
  @ApiOperation({ summary: 'Returns a single subscription' })
  public getSubscription(@Param('id') id: string) {
    return this.subscriptionsService.getById(id);
  }

  @Post('subscriptions')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('webhooks', 'create')
  @ApiOperation({ summary: 'Creates a new subscription (returns secret once)' })
  public createSubscription(
    @Body() dto: CreateWebhookSubscriptionDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ) {
    return this.subscriptionsService.create({
      name: dto.name,
      url: dto.url,
      eventTypes: dto.eventTypes,
      description: dto.description ?? null,
      isActive: dto.isActive ?? true,
      createdById: admin.id,
    });
  }

  @Patch('subscriptions/:id')
  @RequirePermission('webhooks', 'edit')
  @ApiOperation({ summary: 'Updates an existing subscription' })
  public updateSubscription(
    @Param('id') id: string,
    @Body() dto: UpdateWebhookSubscriptionDto,
  ) {
    return this.subscriptionsService.update(id, dto);
  }

  @Delete('subscriptions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('webhooks', 'delete')
  @ApiOperation({ summary: 'Removes a subscription (cascades to deliveries)' })
  public deleteSubscription(@Param('id') id: string) {
    return this.subscriptionsService.delete(id);
  }

  @Post('subscriptions/:id/regenerate-secret')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('webhooks', 'edit')
  @ApiOperation({ summary: 'Issues a fresh signing secret (returned once)' })
  public regenerateSecret(@Param('id') id: string) {
    return this.subscriptionsService.regenerateSecret(id);
  }

  @Post('subscriptions/:id/test')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('webhooks', 'edit')
  @ApiOperation({ summary: 'Sends a synthetic test payload' })
  public testSubscription(@Param('id') id: string) {
    return this.dispatcherService.test(id);
  }

  // ── Deliveries ─────────────────────────────────────────────────────────

  @Get('deliveries')
  @RequirePermission('webhooks', 'view')
  @ApiOperation({ summary: 'Cursor-paginated list of delivery attempts' })
  public listDeliveries(@Query() query: ListDeliveriesQueryDto) {
    const limit = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : query.limit;
    return this.deliveriesService.list({
      subscriptionId: query.subscriptionId,
      status: query.status as WebhookDeliveryStatus | undefined,
      eventType: query.eventType,
      limit: Number.isFinite(limit as number) ? (limit as number) : undefined,
      cursor: query.cursor,
    });
  }

  @Get('deliveries/:id')
  @RequirePermission('webhooks', 'view')
  @ApiOperation({ summary: 'Returns a single delivery with its payload' })
  public getDelivery(@Param('id') id: string) {
    return this.deliveriesService.getById(id);
  }

  @Post('deliveries/:id/replay')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('webhooks', 'edit')
  @ApiOperation({ summary: 'Re-queues a delivery as a fresh attempt' })
  public replayDelivery(@Param('id') id: string) {
    return this.dispatcherService.replay(id);
  }
}
