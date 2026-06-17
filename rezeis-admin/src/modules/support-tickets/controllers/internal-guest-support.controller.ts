import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
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
import { createHash } from 'node:crypto';

import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { SettingsService } from '../../settings/services/settings.service';
import { UploadAttachmentDto } from '../dto/attachment.dto';
import { CreateGuestTicketDto, GuestReplyDto } from '../dto/guest-support.dto';
import { SupportGuestService } from '../services/support-guest.service';
import { AttachGuestDto } from '../dto/guest-support.dto';
import { AttachmentValidationError } from '../utils/support-attachment.util';

/** Header reiwa uses to relay the raw, server-bound guest token. */
const GUEST_TOKEN_HEADER = 'x-support-guest-token';
/** Optional header reiwa uses to relay the visitor's IP (hashed for abuse review). */
const GUEST_IP_HEADER = 'x-support-client-ip';

/**
 * InternalGuestSupportController
 * ──────────────────────────────
 * reiwa-facing surface for ANONYMOUS (guest) support conversations.
 *
 * Auth: `InternalAdminAuthGuard` (api_token) protects the reiwa↔rezeis hop.
 * Conversation authorization is bound ENTIRELY to the server-side guest token
 * relayed in `X-Support-Guest-Token` — there is no ticket/user id in the path
 * or body, so a client cannot assert someone else's conversation. Any
 * unresolved token (unknown / expired / closed) yields a uniform 404.
 */
@ApiTags('internal/support/guest')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/support/guest')
export class InternalGuestSupportController {
  public constructor(
    private readonly guestService: SupportGuestService,
    private readonly systemEvents: SystemEventsService,
    private readonly settingsService: SettingsService,
  ) {}

  @Get('config')
  @ApiOperation({ summary: 'Runtime config for the reiwa edge (enabled + Turnstile)' })
  public getConfig(): Promise<{
    readonly enabled: boolean;
    readonly turnstileSiteKey: string;
    readonly turnstileSecret: string | null;
  }> {
    return this.settingsService.getSupportRuntimeConfig();
  }

  @Post()
  @ApiOperation({ summary: 'Open an anonymous guest support conversation' })
  public async create(
    @Body() body: CreateGuestTicketDto,
    @Headers(GUEST_IP_HEADER) clientIp: string | undefined,
  ): Promise<GuestCreateResponse> {
    const runtime = await this.settingsService.getSupportRuntimeConfig();
    if (!runtime.enabled) throw new NotFoundException('Conversation not found');
    const subject = body.subject.trim();
    const { token, ticketId } = await this.guestService.createConversation({
      subject,
      message: body.message.trim(),
      email: body.email?.trim() || null,
      ipHash: hashIp(clientIp),
    });
    this.systemEvents.info(
      EVENT_TYPES.SUPPORT_TICKET_CREATED,
      'SUPPORT',
      `Гостевой тикет: ${subject}`,
      { ticketId, subject, guest: true },
    );
    const ticket = await this.guestService.getConversation(token);
    return {
      token,
      resumeCode: token,
      ticket: ticket !== null ? serializeGuestTicket(ticket) : null,
    };
  }

  @Get()
  @ApiOperation({ summary: 'Fetch the conversation bound to the guest token' })
  public async get(
    @Headers(GUEST_TOKEN_HEADER) token: string | undefined,
  ): Promise<SerializedGuestTicket> {
    const ticket = await this.guestService.getConversation(token ?? '');
    if (ticket === null) throw new NotFoundException('Conversation not found');
    return serializeGuestTicket(ticket);
  }

  @Post('reply')
  @ApiOperation({ summary: 'Append a guest reply to the bound conversation' })
  public async reply(
    @Headers(GUEST_TOKEN_HEADER) token: string | undefined,
    @Body() body: GuestReplyDto,
  ): Promise<SerializedGuestTicket> {
    const ticket = await this.guestService.reply(token ?? '', body.content.trim());
    if (ticket === null) throw new NotFoundException('Conversation not found');
    this.systemEvents.info(
      EVENT_TYPES.SUPPORT_TICKET_USER_REPLY,
      'SUPPORT',
      'Ответ гостя в обращении',
      { guest: true },
    );
    return serializeGuestTicket(ticket);
  }

  @Post('close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Visitor closes (archives) their own conversation' })
  public async close(
    @Headers(GUEST_TOKEN_HEADER) token: string | undefined,
  ): Promise<{ ok: true }> {
    const ok = await this.guestService.close(token ?? '');
    if (!ok) throw new NotFoundException('Conversation not found');
    return { ok: true };
  }

  @Post('attach')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Attach the guest conversation to a logged-in account' })
  public async attach(
    @Headers(GUEST_TOKEN_HEADER) token: string | undefined,
    @Body() body: AttachGuestDto,
  ): Promise<{ ok: true }> {
    const ok = await this.guestService.attachToUser(token ?? '', body.userRef.trim());
    if (!ok) throw new NotFoundException('Conversation not found');
    this.systemEvents.info(
      EVENT_TYPES.SUPPORT_TICKET_USER_REPLY,
      'SUPPORT',
      'Гостевой тикет привязан к аккаунту',
      { guest: true },
    );
    return { ok: true };
  }

  @Post('attachments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Attach a file to the bound conversation' })
  public async upload(
    @Headers(GUEST_TOKEN_HEADER) token: string | undefined,
    @Body() body: UploadAttachmentDto,
  ): Promise<SerializedGuestTicket> {
    let ticket: unknown | null;
    try {
      ticket = await this.guestService.addAttachment(token ?? '', {
        filename: body.filename,
        mimeType: body.mimeType,
        content: body.content,
        dataBase64: body.dataBase64,
      });
    } catch (err: unknown) {
      throw mapAttachmentError(err);
    }
    if (ticket === null) throw new NotFoundException('Conversation not found');
    this.systemEvents.info(
      EVENT_TYPES.SUPPORT_TICKET_USER_REPLY,
      'SUPPORT',
      'Гость прикрепил файл в обращении',
      { guest: true },
    );
    return serializeGuestTicket(ticket);
  }

  @Get('attachments/:attachmentId')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Stream an attachment on the bound conversation' })
  public async download(
    @Headers(GUEST_TOKEN_HEADER) token: string | undefined,
    @Param('attachmentId') attachmentId: string,
  ): Promise<StreamableFile> {
    const file = await this.guestService.streamAttachment(token ?? '', attachmentId);
    if (file === null) throw new NotFoundException('Attachment not found');
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      length: file.sizeBytes,
      disposition: `inline; filename="${encodeURIComponent(file.filename)}"`,
    });
  }
}

// ── Serialization (guest-safe; UPPERCASE enums → lowercase SPA contract) ──────

interface GuestTicketEntity {
  readonly id: string;
  readonly subject: string;
  readonly status: string;
  readonly channel: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly messages?: ReadonlyArray<{
    readonly id: string;
    readonly authorType: string;
    readonly content: string;
    readonly createdAt: Date;
    readonly metadata?: unknown;
    readonly attachments?: ReadonlyArray<{
      readonly id: string;
      readonly filename: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
    }>;
  }>;
}

interface SerializedGuestAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

interface SerializedGuestTicket {
  readonly id: string;
  readonly subject: string;
  readonly status: string;
  readonly channel: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly authorType: string;
    readonly content: string;
    readonly createdAt: string;
    readonly metadata: unknown;
    readonly attachments: ReadonlyArray<SerializedGuestAttachment>;
  }>;
}

interface GuestCreateResponse {
  readonly token: string;
  readonly resumeCode: string;
  readonly ticket: SerializedGuestTicket | null;
}

function serializeGuestTicket(ticket: unknown): SerializedGuestTicket {
  const t = ticket as GuestTicketEntity;
  return {
    id: t.id,
    subject: t.subject,
    status: t.status.toLowerCase(),
    channel: t.channel.toLowerCase(),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    messages: (t.messages ?? []).map((m) => ({
      id: m.id,
      authorType: m.authorType.toLowerCase(),
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      metadata: m.metadata ?? null,
      attachments: (m.attachments ?? []).map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
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

/** SHA-256 of the visitor IP for abuse review — never store the raw IP. */
function hashIp(ip: string | undefined): string | null {
  const trimmed = (ip ?? '').split(',')[0]?.trim() ?? '';
  if (trimmed.length === 0) return null;
  return createHash('sha256').update(trimmed).digest('hex');
}
