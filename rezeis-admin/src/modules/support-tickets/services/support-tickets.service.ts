import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SupportTicketStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

interface ListTicketsQuery {
  readonly userId?: string;
  readonly userTelegramId?: bigint;
  readonly status?: SupportTicketStatus;
  readonly channel?: 'CABINET' | 'GUEST';
  /** When true, return CLOSED (archived) conversations; otherwise active only. */
  readonly archived?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

interface CreateTicketInput {
  readonly userId: string;
  readonly subject: string;
}

interface CreateGuestTicketInput {
  readonly guestId: string;
  readonly subject: string;
}

interface AddMessageInput {
  readonly ticketId: string;
  readonly authorType: 'USER' | 'ADMIN' | 'SYSTEM';
  readonly authorId: string | null;
  readonly content: string;
  readonly metadata?: Prisma.InputJsonValue;
}

interface CreateDocumentRequestInput {
  readonly ticketId: string;
  readonly requestedBy: string;
  readonly kind: 'PAYMENT_PROOF' | 'DOCUMENT' | 'LOGIN' | 'OTHER';
  readonly label: string;
}

interface CloseTicketInput {
  readonly ticketId: string;
  readonly closedBy: string;
}

/**
 * Support ticket CRUD. Donor parity: altshop does not have a dedicated
 * support module — this is a rezeis-admin addition for operator workflows.
 */
@Injectable()
export class SupportTicketsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async list(query: ListTicketsQuery) {
    const where: Prisma.SupportTicketWhereInput = {
      userId: query.userId,
    };
    if (query.userTelegramId !== undefined) {
      where.user = { telegramId: query.userTelegramId };
    }
    if (query.channel !== undefined) {
      where.channel = query.channel;
    }
    // Active queue (OPEN/WAITING_REPLY) vs archive (CLOSED). The archive is
    // gated by `support_tickets.archive` in the controller — never widen it
    // here.
    if (query.archived === true) {
      where.status = SupportTicketStatus.CLOSED;
    } else if (query.status !== undefined && query.status !== SupportTicketStatus.CLOSED) {
      where.status = query.status;
    } else {
      where.status = { in: [SupportTicketStatus.OPEN, SupportTicketStatus.WAITING_REPLY] };
    }
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const [items, total] = await Promise.all([
      this.prismaService.supportTicket.findMany({
        where,
        include: {
          messages: { orderBy: { createdAt: 'asc' }, take: 1 },
          user: { select: { id: true, telegramId: true, name: true, username: true, email: true } },
          guest: { select: { id: true, email: true, displayName: true } },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prismaService.supportTicket.count({ where }),
    ]);
    return { items, total };
  }

  /** Lightweight archived/closed check used to gate reads by permission. */
  public async isArchived(ticketId: string): Promise<boolean> {
    const ticket = await this.prismaService.supportTicket.findUnique({
      where: { id: ticketId },
      select: { archivedAt: true, status: true },
    });
    if (ticket === null) return false;
    return ticket.archivedAt !== null || ticket.status === SupportTicketStatus.CLOSED;
  }

  public async getById(ticketId: string) {
    const ticket = await this.prismaService.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            attachments: {
              select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
        docRequests: { orderBy: { createdAt: 'asc' } },
        user: { select: { id: true, telegramId: true, name: true, username: true, email: true, language: true } },
      },
    });
    if (ticket === null) {
      throw new NotFoundException('Support ticket not found');
    }
    return ticket;
  }

  public async reopen(ticketId: string) {
    const ticket = await this.prismaService.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, status: true },
    });
    if (ticket === null) {
      throw new NotFoundException('Support ticket not found');
    }
    return this.prismaService.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: SupportTicketStatus.OPEN,
        closedAt: null,
        closedBy: null,
        archivedAt: null,
      },
    });
  }

  public async create(input: CreateTicketInput) {
    return this.prismaService.supportTicket.create({
      data: {
        userId: input.userId,
        subject: input.subject,
        status: SupportTicketStatus.OPEN,
      },
    });
  }

  /**
   * Create a guest-owned (anonymous) ticket. Channel is GUEST and there is
   * no `userId` — the owner-exclusivity CHECK in the DB enforces that exactly
   * one of user_id / guest_id is set.
   */
  public async createGuest(input: CreateGuestTicketInput) {
    return this.prismaService.supportTicket.create({
      data: {
        guestId: input.guestId,
        channel: 'GUEST',
        subject: input.subject,
        status: SupportTicketStatus.OPEN,
      },
    });
  }

  public async addMessage(input: AddMessageInput) {
    const ticket = await this.prismaService.supportTicket.findUnique({
      where: { id: input.ticketId },
      select: { id: true, status: true },
    });
    if (ticket === null) {
      throw new NotFoundException('Support ticket not found');
    }
    const message = await this.prismaService.supportTicketMessage.create({
      data: {
        ticketId: input.ticketId,
        authorType: input.authorType,
        authorId: input.authorId,
        content: input.content,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
    // Update ticket status to WAITING_REPLY when admin responds
    if (input.authorType === 'ADMIN' && ticket.status === SupportTicketStatus.OPEN) {
      await this.prismaService.supportTicket.update({
        where: { id: input.ticketId },
        data: { status: SupportTicketStatus.WAITING_REPLY },
      });
    }
    // Reopen if user responds to a waiting ticket
    if (input.authorType === 'USER' && ticket.status === SupportTicketStatus.WAITING_REPLY) {
      await this.prismaService.supportTicket.update({
        where: { id: input.ticketId },
        data: { status: SupportTicketStatus.OPEN },
      });
    }
    // A user/guest reply satisfies the oldest still-pending document request
    // on the ticket (fulfillment "by a message" — the operator can still
    // cancel or ask again). SYSTEM/ADMIN messages never fulfill.
    if (input.authorType === 'USER') {
      await this.fulfillOldestPendingRequest(input.ticketId, message.id);
    }
    return message;
  }

  /**
   * Create an operator document request and surface it inline as a SYSTEM
   * message so the visitor sees the ask. Returns the created request.
   */
  public async createDocumentRequest(input: CreateDocumentRequestInput) {
    const ticket = await this.prismaService.supportTicket.findUnique({
      where: { id: input.ticketId },
      select: { id: true },
    });
    if (ticket === null) {
      throw new NotFoundException('Support ticket not found');
    }
    const request = await this.prismaService.supportDocumentRequest.create({
      data: {
        ticketId: input.ticketId,
        requestedBy: input.requestedBy,
        kind: input.kind,
        label: input.label,
      },
    });
    await this.addMessage({
      ticketId: input.ticketId,
      authorType: 'SYSTEM',
      authorId: input.requestedBy,
      content: input.label,
      metadata: { type: 'document_request', docRequestId: request.id, kind: input.kind },
    });
    return request;
  }

  /** Mark the oldest PENDING request on a ticket FULFILLED by `messageId`. */
  private async fulfillOldestPendingRequest(ticketId: string, messageId: string): Promise<void> {
    const pending = await this.prismaService.supportDocumentRequest.findFirst({
      where: { ticketId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (pending === null) return;
    await this.prismaService.supportDocumentRequest.update({
      where: { id: pending.id },
      data: { status: 'FULFILLED', fulfilledMessageId: messageId },
    });
  }

  public async close(input: CloseTicketInput) {
    const ticket = await this.prismaService.supportTicket.findUnique({
      where: { id: input.ticketId },
      select: { id: true, status: true },
    });
    if (ticket === null) {
      throw new NotFoundException('Support ticket not found');
    }
    return this.prismaService.supportTicket.update({
      where: { id: input.ticketId },
      data: {
        status: SupportTicketStatus.CLOSED,
        closedAt: new Date(),
        archivedAt: new Date(),
        closedBy: input.closedBy,
      },
    });
  }

  public async getStats() {
    const [open, waitingReply, closed, total] = await Promise.all([
      this.prismaService.supportTicket.count({ where: { status: SupportTicketStatus.OPEN } }),
      this.prismaService.supportTicket.count({ where: { status: SupportTicketStatus.WAITING_REPLY } }),
      this.prismaService.supportTicket.count({ where: { status: SupportTicketStatus.CLOSED } }),
      this.prismaService.supportTicket.count(),
    ]);
    return { open, waitingReply, closed, total };
  }
}
