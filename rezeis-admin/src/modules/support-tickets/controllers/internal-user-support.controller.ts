import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SupportTicket, SupportTicketMessage, SupportTicketStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVENT_TYPES,
  SystemEventsService,
} from '../../../common/services/system-events.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import { UploadAttachmentDto } from '../dto/attachment.dto';
import { AttachmentValidationError } from '../utils/support-attachment.util';
import { SupportAttachmentService } from '../services/support-attachment.service';
import { SupportTicketsService } from '../services/support-tickets.service';

/**
 * InternalUserSupportController
 * ─────────────────────────────
 * User-facing support ticket surface consumed by reiwa (SPA / Mini App).
 *
 * Auth: `InternalAdminAuthGuard` (api_token) — reiwa has already proven the
 * end-user identity through its own session and passes it as `:userRef`,
 * which is a reiwa_id (CUID) for web-first users or a numeric telegramId
 * for Telegram users. Every read/write is scoped to the resolved user so a
 * user can never touch another user's ticket.
 *
 * The response shape matches the reiwa SPA contract: lowercase `status` /
 * `authorType`, ISO timestamps, full message thread.
 */
@ApiTags('internal/user/support')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/user')
export class InternalUserSupportController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly supportTicketsService: SupportTicketsService,
    private readonly supportAttachments: SupportAttachmentService,
    private readonly systemEvents: SystemEventsService,
  ) {}

  @Get(':userRef/tickets')
  @ApiOperation({ summary: 'List the calling user\'s support tickets' })
  public async list(@Param('userRef') userRef: string): Promise<readonly SerializedTicket[]> {
    const userId = await this.resolveUserId(userRef);
    const { items } = await this.supportTicketsService.list({ userId, allStatuses: true });
    return items.map(serializeTicket);
  }

  @Get(':userRef/tickets/:ticketId')
  @ApiOperation({ summary: 'Fetch a single ticket (must belong to the user)' })
  public async getOne(
    @Param('userRef') userRef: string,
    @Param('ticketId') ticketId: string,
  ): Promise<SerializedTicket> {
    const userId = await this.resolveUserId(userRef);
    const ticket = await this.supportTicketsService.getById(ticketId);
    if (ticket.userId !== userId) {
      throw new NotFoundException('Support ticket not found');
    }
    // Opening the ticket is an implicit "read" of the support reply that
    // prompted the notification. Clear any unread `support_reply` events for
    // THIS ticket so the cabinet bell / settings badge stop nagging once the
    // user is already looking at the conversation. Best-effort: a failure here
    // must never block returning the ticket.
    try {
      await this.prismaService.userNotificationEvent.updateMany({
        where: {
          userId,
          type: 'support_reply',
          readAt: null,
          payload: { path: ['ticketId'], equals: ticketId },
        },
        data: { readAt: new Date() },
      });
    } catch {
      // swallow — read view must still render even if the mark-read fails
    }
    return serializeTicket(ticket);
  }

  @Get(':userRef/tickets/:ticketId/attachments/:attachmentId')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Stream an attachment from the user\'s own ticket' })
  public async downloadAttachment(
    @Param('userRef') userRef: string,
    @Param('ticketId') ticketId: string,
    @Param('attachmentId') attachmentId: string,
  ): Promise<StreamableFile> {
    const userId = await this.resolveUserId(userRef);
    const ticket = await this.supportTicketsService.getById(ticketId);
    // Ownership gate: a user may only stream attachments from their own ticket.
    if (ticket.userId !== userId) {
      throw new HttpException('Attachment not found', HttpStatus.NOT_FOUND);
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

  @Post(':userRef/tickets')
  @ApiOperation({ summary: 'Create a ticket with an initial message' })
  public async create(
    @Param('userRef') userRef: string,
    @Body() body: { subject?: string; message?: string },
  ): Promise<SerializedTicket> {
    const userId = await this.resolveUserId(userRef);
    const subject = (body.subject ?? '').trim();
    const message = (body.message ?? '').trim();
    if (subject.length === 0 || message.length === 0) {
      throw new BadRequestException('Subject and message are required');
    }
    const created = await this.supportTicketsService.create({ userId, subject });
    await this.supportTicketsService.addMessage({
      ticketId: created.id,
      authorType: 'USER',
      authorId: userId,
      content: message,
    });
    this.systemEvents.info(
      EVENT_TYPES.SUPPORT_TICKET_CREATED,
      'SUPPORT',
      `Новый тикет: ${subject}`,
      { ticketId: created.id, userId, subject },
    );
    return serializeTicket(await this.supportTicketsService.getById(created.id));
  }

  /**
   * Attach a file to the customer's own ticket.
   *
   * ── Why this did not exist ───────────────────────────────────────────
   *
   * Every part of it did. The bytes are validated, sniffed and stored by
   * `SupportAttachmentService`; the ANONYMOUS guest conversation has had an
   * upload route since attachments shipped; the cabinet already renders and
   * streams attachments. The one thing missing was this route — so a customer
   * who had signed in could SEE files and never send one.
   *
   * The visible consequence was the document-request feature: an operator
   * asks for a receipt, the customer opens the ticket, and there is nothing
   * to press. The ask went out and nothing ever came back.
   */
  @Post(':userRef/tickets/:ticketId/attachments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Attach a file to the user\'s own ticket' })
  public async uploadAttachment(
    @Param('userRef') userRef: string,
    @Param('ticketId') ticketId: string,
    @Body() body: UploadAttachmentDto,
  ): Promise<SerializedTicket> {
    const userId = await this.resolveUserId(userRef);
    // Ownership first, and by the same read the reply route uses: an
    // attachment is a write, and a write onto somebody else's thread must be
    // impossible rather than merely unlikely.
    const ticket = await this.prismaService.supportTicket.findFirst({
      where: { id: ticketId, userId },
      select: { id: true, status: true },
    });
    if (ticket === null) {
      throw new NotFoundException('Support ticket not found');
    }
    if (ticket.status === SupportTicketStatus.CLOSED) {
      // The cabinet hides the composer on a closed thread; refusing here is
      // what makes that a rule rather than a suggestion.
      throw new BadRequestException('Support ticket is closed');
    }

    try {
      await this.supportAttachments.storeForMessage({
        ticketId,
        authorType: 'USER',
        authorId: userId,
        content: body.content,
        filename: body.filename,
        declaredMime: body.mimeType,
        dataBase64: body.dataBase64,
      });
    } catch (err: unknown) {
      throw mapAttachmentError(err);
    }

    this.systemEvents.info(
      EVENT_TYPES.SUPPORT_TICKET_USER_REPLY,
      'SUPPORT',
      'Пользователь прикрепил файл в обращении',
      { ticketId, userId },
    );
    return serializeTicket(await this.supportTicketsService.getById(ticketId));
  }

  @Post(':userRef/tickets/:ticketId/reply')
  @ApiOperation({ summary: 'Append a user reply to the user\'s own ticket' })
  public async reply(
    @Param('userRef') userRef: string,
    @Param('ticketId') ticketId: string,
    @Body() body: { content?: string },
  ): Promise<SerializedTicket> {
    const userId = await this.resolveUserId(userRef);
    const content = (body.content ?? '').trim();
    if (content.length === 0) {
      throw new BadRequestException('Content is required');
    }
    const ticket = await this.supportTicketsService.getById(ticketId);
    if (ticket.userId !== userId) {
      throw new ForbiddenException('Ticket does not belong to this user');
    }
    await this.supportTicketsService.addMessage({
      ticketId,
      authorType: 'USER',
      authorId: userId,
      content,
    });
    this.systemEvents.info(
      EVENT_TYPES.SUPPORT_TICKET_USER_REPLY,
      'SUPPORT',
      `Ответ пользователя в тикете: ${ticket.subject}`,
      { ticketId, userId, subject: ticket.subject },
    );
    return serializeTicket(await this.supportTicketsService.getById(ticketId));
  }

  private async resolveUserId(userRef: string): Promise<string> {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(userRef),
      select: { id: true },
    });
    if (user === null) {
      throw new NotFoundException('User not found');
    }
    return user.id;
  }
}

// ── Serialization (DB enums UPPERCASE → SPA lowercase) ──────────────────────

interface SerializedAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly purgedAt?: Date | string | null;
  readonly createdAt: string;
}

interface SerializedTicketMessage {
  readonly id: string;
  readonly authorType: string;
  readonly content: string;
  readonly createdAt: string;
  readonly attachments: readonly SerializedAttachment[];
}

interface SerializedTicket {
  readonly id: string;
  readonly subject: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly SerializedTicketMessage[];
}

interface AttachmentRow {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly purgedAt?: Date | string | null;
  readonly createdAt: Date;
}

type MessageWithAttachments = SupportTicketMessage & {
  readonly attachments?: readonly AttachmentRow[];
};

type TicketWithMessages = SupportTicket & { messages?: MessageWithAttachments[] };

function serializeTicket(ticket: TicketWithMessages): SerializedTicket {
  return {
    id: ticket.id,
    subject: ticket.subject,
    status: ticket.status.toLowerCase(),
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    messages: (ticket.messages ?? []).map((message) => ({
      id: message.id,
      authorType: message.authorType.toLowerCase(),
      content: message.content,
      createdAt: message.createdAt.toISOString(),
      // Recipient parity: the cabinet now receives attachment metadata so an
      // attachment-only reply from an operator renders as a file/image instead
      // of an empty bubble. The binary is fetched via the streaming endpoint.
      attachments: (message.attachments ?? []).map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        // Purged: the bytes are gone, the record is not. Both surfaces
        // render this as «файл удалён» rather than a link that 404s.
        purgedAt: a.purgedAt ?? null,
        createdAt: a.createdAt.toISOString(),
      })),
    })),
  };
}

/** Map attachment validation failures to 413 (oversize) / 415 (other). */
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
