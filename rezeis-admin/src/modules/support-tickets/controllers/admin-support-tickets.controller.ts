import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SupportTicketStatus, SupportTicket, SupportTicketMessage, User } from '@prisma/client';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { SupportTicketsService } from '../services/support-tickets.service';

/**
 * AdminSupportTicketsController
 * ─────────────────────────────
 * Operator-facing support ticket workflow. The frontend feature
 * `web/src/features/support-tickets` is the primary consumer; the request
 * shapes here mirror what that feature expects:
 *
 *   - `userTelegramId` (string of a BigInt) instead of the internal CUID
 *   - `messages: { authorType, authorId, content, createdAt }[]`
 *   - flat status filter via `?status=open|waiting_reply|closed`
 *
 * Auth: `AdminJwtAuthGuard` + RBAC `support_tickets.{view,edit,resolve}`.
 */
@ApiTags('admin/support-tickets')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@Controller('admin/support-tickets')
export class AdminSupportTicketsController {
  public constructor(
    private readonly supportTicketsService: SupportTicketsService,
  ) {}

  @Get()
  @RequirePermission('support_tickets', 'view')
  @ApiOperation({ summary: 'List tickets for the operator queue' })
  public async list(
    @Query('status') status: string | undefined,
    @Query('userTelegramId') userTelegramId: string | undefined,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<{ readonly items: ReadonlyArray<unknown>; readonly total: number }> {
    const parsedStatus = parseStatus(status);
    const parsedTelegramId = parseTelegramId(userTelegramId);
    const result = await this.supportTicketsService.list({
      status: parsedStatus,
      userTelegramId: parsedTelegramId,
      limit: clampInt(limit, 1, 200),
      offset: Math.max(0, offset),
    });
    return {
      items: result.items.map(serializeTicket),
      total: result.total,
    };
  }

  @Get('stats')
  @RequirePermission('support_tickets', 'view')
  @ApiOperation({ summary: 'Aggregate counters for the dashboard widget' })
  public getStats() {
    return this.supportTicketsService.getStats();
  }

  @Get(':ticketId')
  @RequirePermission('support_tickets', 'view')
  @ApiOperation({ summary: 'Full ticket detail with the entire message thread' })
  public async getById(@Param('ticketId') ticketId: string): Promise<unknown> {
    const ticket = await this.supportTicketsService.getById(ticketId);
    return serializeTicket(ticket);
  }

  @Post(':ticketId/reply')
  @RequirePermission('support_tickets', 'edit')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Append an admin reply to the ticket' })
  public async reply(
    @Param('ticketId') ticketId: string,
    @Body() body: { content?: unknown },
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<unknown> {
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    if (content.length === 0) {
      throw new BadRequestException('Reply content must be a non-empty string');
    }
    if (content.length > 10_000) {
      throw new BadRequestException('Reply content exceeds 10,000 characters');
    }
    await this.supportTicketsService.addMessage({
      ticketId,
      authorType: 'ADMIN',
      authorId: admin.id,
      content,
    });
    return serializeTicket(await this.supportTicketsService.getById(ticketId));
  }

  @Post(':ticketId/close')
  @RequirePermission('support_tickets', 'resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark the ticket as closed' })
  public async close(
    @Param('ticketId') ticketId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<unknown> {
    await this.supportTicketsService.close({ ticketId, closedBy: admin.id });
    return serializeTicket(await this.supportTicketsService.getById(ticketId));
  }

  @Post(':ticketId/reopen')
  @RequirePermission('support_tickets', 'edit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reopen a previously closed ticket' })
  public async reopen(@Param('ticketId') ticketId: string): Promise<unknown> {
    await this.supportTicketsService.reopen(ticketId);
    return serializeTicket(await this.supportTicketsService.getById(ticketId));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type TicketWithRelations = SupportTicket & {
  readonly messages?: ReadonlyArray<SupportTicketMessage>;
  readonly user?: Pick<User, 'id' | 'telegramId' | 'name' | 'username' | 'email'> | null;
};

/**
 * The frontend renders Telegram IDs as opaque strings to avoid any precision
 * loss with `bigint`. We also lower-case the status so the React feature can
 * compare it directly to its filter values (`open`, `waiting_reply`, `closed`).
 */
function serializeTicket(ticket: TicketWithRelations): Record<string, unknown> {
  return {
    id: ticket.id,
    userId: ticket.userId,
    userTelegramId: ticket.user?.telegramId?.toString() ?? null,
    subject: ticket.subject,
    status: ticket.status.toLowerCase(),
    closedAt: ticket.closedAt,
    closedBy: ticket.closedBy,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    user: ticket.user
      ? {
          id: ticket.user.id,
          telegramId: ticket.user.telegramId?.toString() ?? null,
          name: ticket.user.name,
          username: ticket.user.username,
          email: ticket.user.email,
        }
      : null,
    messages: (ticket.messages ?? []).map((message) => ({
      id: message.id,
      authorType: message.authorType.toLowerCase(),
      authorId: message.authorId,
      content: message.content,
      createdAt: message.createdAt,
    })),
  };
}

function parseStatus(input: string | undefined): SupportTicketStatus | undefined {
  if (!input || input === 'all') {
    return undefined;
  }
  const normalised = input.toUpperCase().replace(/-/g, '_');
  const valid: ReadonlyArray<SupportTicketStatus> = [
    SupportTicketStatus.OPEN,
    SupportTicketStatus.WAITING_REPLY,
    SupportTicketStatus.CLOSED,
  ];
  return valid.find((status) => status === normalised);
}

function parseTelegramId(input: string | undefined): bigint | undefined {
  if (!input) return undefined;
  if (!/^\d+$/.test(input)) {
    throw new BadRequestException('userTelegramId must be a numeric string');
  }
  try {
    return BigInt(input);
  } catch {
    throw new BadRequestException('userTelegramId is not a valid BigInt');
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
