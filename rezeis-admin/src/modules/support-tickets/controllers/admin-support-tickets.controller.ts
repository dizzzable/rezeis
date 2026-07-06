import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, SupportTicketStatus, SupportTicket, SupportTicketMessage, User } from '@prisma/client';
import type { Request } from 'express';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { RbacService } from '../../rbac/services/rbac.service';
import { SettingsService } from '../../settings/services/settings.service';
import { UpdateSupportSettingsDto } from '../../settings/dto/update-support-settings.dto';
import { UploadAttachmentDto } from '../dto/attachment.dto';
import { CreateDocumentRequestDto } from '../dto/document-request.dto';
import { SupportAttachmentService } from '../services/support-attachment.service';
import { SupportNotificationsService } from '../services/support-notifications.service';
import { SupportTicketsService } from '../services/support-tickets.service';
import { AttachmentValidationError } from '../utils/support-attachment.util';

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
    private readonly supportNotifications: SupportNotificationsService,
    private readonly supportAttachments: SupportAttachmentService,
    private readonly prismaService: PrismaService,
    private readonly rbacService: RbacService,
    private readonly settingsService: SettingsService,
  ) {}

  @Get()
  @RequirePermission('support_tickets', 'view')
  @ApiOperation({ summary: 'List tickets for the operator queue' })
  public async list(
    @Query('status') status: string | undefined,
    @Query('channel') channel: string | undefined,
    @Query('archived') archived: string | undefined,
    @Query('userTelegramId') userTelegramId: string | undefined,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<{ readonly items: ReadonlyArray<unknown>; readonly total: number }> {
    const parsedStatus = parseStatus(status);
    const parsedTelegramId = parseTelegramId(userTelegramId);
    const parsedChannel = parseChannel(channel);
    // Archive (CLOSED conversations) is a separate, more sensitive read:
    // it requires `support_tickets.archive`. A `closed` status filter is
    // treated as an archive request for the same reason.
    const wantsArchive = archived === 'true' || parsedStatus === SupportTicketStatus.CLOSED;
    if (wantsArchive) {
      await this.assertArchivePermission(admin);
    }
    const result = await this.supportTicketsService.list({
      status: wantsArchive ? undefined : parsedStatus,
      channel: parsedChannel,
      archived: wantsArchive,
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

  @Get('config')
  @RequirePermission('support_tickets', 'view')
  @ApiOperation({ summary: 'Panel-managed anonymous support settings (secret redacted)' })
  public getConfig() {
    return this.settingsService.getSupportSettings();
  }

  @Post('config')
  @RequirePermission('settings', 'edit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update anonymous support settings (enabled, caps, Turnstile)' })
  public async updateConfig(
    @Body() body: UpdateSupportSettingsDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<unknown> {
    return this.settingsService.updateSupportSettings({
      currentAdmin: admin,
      requestMetadata: extractRequestMetadata(req),
      patch: body,
    });
  }

  @Get(':ticketId')
  @RequirePermission('support_tickets', 'view')
  @ApiOperation({ summary: 'Full ticket detail with the entire message thread' })
  public async getById(
    @Param('ticketId') ticketId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<unknown> {
    if (await this.supportTicketsService.isArchived(ticketId)) {
      await this.assertArchivePermission(admin);
    }
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
    @Req() req: Request,
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
    await this.audit(admin, req, 'support_ticket.reply', { ticketId });
    const ticket = await this.supportTicketsService.getById(ticketId);
    // Best-effort: notify the ticket owner (cabinet feed + bot DM + web-push,
    // or a resume email for a guest). Fire-and-forget — never block the reply.
    this.notifyTicketOwner(ticket);
    return serializeTicket(ticket);
  }

  @Post(':ticketId/close')
  @RequirePermission('support_tickets', 'resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark the ticket as closed' })
  public async close(
    @Param('ticketId') ticketId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<unknown> {
    await this.supportTicketsService.close({ ticketId, closedBy: admin.id });
    await this.audit(admin, req, 'support_ticket.close', { ticketId });
    return serializeTicket(await this.supportTicketsService.getById(ticketId));
  }

  @Post(':ticketId/reopen')
  @RequirePermission('support_tickets', 'edit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reopen a previously closed ticket' })
  public async reopen(
    @Param('ticketId') ticketId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<unknown> {
    // Reopening reads + mutates an archived conversation → archive-gated.
    await this.assertArchivePermission(admin);
    await this.supportTicketsService.reopen(ticketId);
    await this.audit(admin, req, 'support_ticket.reopen', { ticketId });
    return serializeTicket(await this.supportTicketsService.getById(ticketId));
  }

  @Post(':ticketId/attachments')
  @RequirePermission('support_tickets', 'edit')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Attach a file (as a new message) to the ticket' })
  public async upload(
    @Param('ticketId') ticketId: string,
    @Body() body: UploadAttachmentDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<unknown> {
    // Ensure the ticket exists (and surface a clean 404) before storing bytes.
    await this.supportTicketsService.getById(ticketId);
    try {
      await this.supportAttachments.storeForMessage({
        ticketId,
        authorType: 'ADMIN',
        authorId: admin.id,
        content: body.content,
        filename: body.filename,
        declaredMime: body.mimeType,
        dataBase64: body.dataBase64,
      });
    } catch (err: unknown) {
      throw mapAttachmentError(err);
    }
    await this.audit(admin, req, 'support_ticket.attachment', { ticketId });
    const ticket = await this.supportTicketsService.getById(ticketId);
    this.notifyTicketOwner(ticket);
    return serializeTicket(ticket);
  }

  @Post(':ticketId/document-request')
  @RequirePermission('support_tickets', 'edit')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Request identity/proof from the visitor (inline SYSTEM message)' })
  public async requestDocument(
    @Param('ticketId') ticketId: string,
    @Body() body: CreateDocumentRequestDto,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ): Promise<unknown> {
    await this.supportTicketsService.getById(ticketId);
    await this.supportTicketsService.createDocumentRequest({
      ticketId,
      requestedBy: admin.id,
      kind: body.kind,
      label: body.label.trim(),
    });
    await this.audit(admin, req, 'support_ticket.document_request', { ticketId, kind: body.kind });
    const ticket = await this.supportTicketsService.getById(ticketId);
    // Surface the ask to the owner like any other reply (best-effort).
    this.notifyTicketOwner(ticket);
    return serializeTicket(ticket);
  }

  @Get(':ticketId/attachments/:attachmentId')
  @RequirePermission('support_tickets', 'view')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Stream a ticket attachment to the operator' })
  public async download(
    @Param('ticketId') ticketId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
  ): Promise<StreamableFile> {
    // Attachments on an archived conversation inherit the archive gate.
    if (await this.supportTicketsService.isArchived(ticketId)) {
      await this.assertArchivePermission(admin);
    }
    const file = await this.supportAttachments.streamForTicket(ticketId, attachmentId);
    if (file === null) {
      throw new HttpException('Attachment not found', HttpStatus.NOT_FOUND);
    }
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      length: file.sizeBytes,
      disposition: `inline; filename="${encodeURIComponent(file.filename)}"`,
    });
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Best-effort owner notification after an operator action. Account tickets
   * fan out to cabinet/bot/web-push; guest tickets get a resume email (when
   * the visitor left one). Fire-and-forget — never blocks the request.
   */
  private notifyTicketOwner(ticket: {
    readonly id: string;
    readonly subject: string;
    readonly user?: { readonly id: string; readonly language: string | null } | null;
  }): void {
    if (ticket.user) {
      void this.supportNotifications.notifyAdminReply({
        ticketId: ticket.id,
        subject: ticket.subject,
        user: { id: ticket.user.id, language: ticket.user.language },
      });
    } else {
      void this.supportNotifications.notifyGuestReply(ticket.id);
    }
  }

  /** Enforce `support_tickets.archive` for reads/writes on archived threads. */
  private async assertArchivePermission(admin: CurrentAdminInterface): Promise<void> {
    const ok = await this.rbacService.hasPermission(
      { id: admin.id, role: admin.role, rbacRoleId: admin.rbacRoleId },
      'support_tickets',
      'archive',
    );
    if (!ok) {
      throw new ForbiddenException('Archive access requires support_tickets.archive');
    }
  }

  /** Append an audit-log entry (best-effort; mirrors the user-mgmt pattern). */
  private async audit(
    admin: CurrentAdminInterface,
    req: Request,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const rm = extractRequestMetadata(req);
    await this.prismaService.adminAuditLog
      .create({
        data: {
          action,
          ipAddress: rm.remoteAddress,
          userAgent: rm.userAgent,
          metadata: { requestId: rm.requestId, ...metadata } as Prisma.InputJsonObject,
          adminUser: { connect: { id: admin.id } },
        },
      })
      .catch(() => undefined);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type AttachmentRow = {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: Date;
};

type DocRequestRow = {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly status: string;
  readonly fulfilledMessageId: string | null;
  readonly createdAt: Date;
};

type TicketWithRelations = SupportTicket & {
  readonly messages?: ReadonlyArray<SupportTicketMessage & { readonly attachments?: ReadonlyArray<AttachmentRow> }>;
  readonly docRequests?: ReadonlyArray<DocRequestRow>;
  readonly user?:
    | (Pick<User, 'id' | 'telegramId' | 'name' | 'username' | 'email'> & {
        readonly webAccount?: { readonly login: string | null; readonly email: string | null } | null;
      })
    | null;
  readonly guest?: { readonly id: string; readonly email: string | null; readonly displayName: string | null } | null;
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
    channel: ticket.channel.toLowerCase(),
    archivedAt: ticket.archivedAt,
    closedAt: ticket.closedAt,
    closedBy: ticket.closedBy,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    guest: ticket.guest
      ? { id: ticket.guest.id, email: ticket.guest.email, displayName: ticket.guest.displayName }
      : null,
    user: ticket.user
      ? {
          id: ticket.user.id,
          telegramId: ticket.user.telegramId?.toString() ?? null,
          name: ticket.user.name,
          username: ticket.user.username,
          // Web-cabinet login (WebAccount.login) — the identifier web-first
          // users sign in with. Surfaced so the operator can tell WHO wrote the
          // ticket even when there's no Telegram username.
          login: ticket.user.webAccount?.login ?? null,
          email: ticket.user.email ?? ticket.user.webAccount?.email ?? null,
        }
      : null,
    messages: (ticket.messages ?? []).map((message) => ({
      id: message.id,
      authorType: message.authorType.toLowerCase(),
      authorId: message.authorId,
      content: message.content,
      createdAt: message.createdAt,
      metadata: message.metadata ?? null,
      attachments: (message.attachments ?? []).map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        createdAt: a.createdAt,
      })),
    })),
    docRequests: (ticket.docRequests ?? []).map((d) => ({
      id: d.id,
      kind: d.kind.toLowerCase(),
      label: d.label,
      status: d.status.toLowerCase(),
      fulfilledMessageId: d.fulfilledMessageId,
      createdAt: d.createdAt,
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

function parseChannel(input: string | undefined): 'CABINET' | 'GUEST' | undefined {
  if (!input || input === 'all') return undefined;
  const normalised = input.toUpperCase();
  if (normalised === 'CABINET' || normalised === 'GUEST') return normalised;
  return undefined;
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

/**
 * Map an attachment validation failure to the right HTTP status:
 * oversize → 413, anything else (bad type / magic-byte mismatch / encoding)
 * → 415. Non-validation errors propagate unchanged.
 */
function mapAttachmentError(err: unknown): HttpException {
  if (err instanceof AttachmentValidationError) {
    if (err.reason === 'too-large') {
      return new HttpException('Attachment exceeds the size limit', HttpStatus.PAYLOAD_TOO_LARGE);
    }
    return new HttpException('Attachment type is not allowed', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
  }
  if (err instanceof HttpException) return err;
  return new HttpException('Attachment could not be stored', HttpStatus.INTERNAL_SERVER_ERROR);
}
