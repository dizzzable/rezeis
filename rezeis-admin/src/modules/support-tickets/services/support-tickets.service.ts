import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SupportTicketStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

interface ListTicketsQuery {
  readonly userId?: string;
  readonly userTelegramId?: bigint;
  readonly status?: SupportTicketStatus;
  readonly limit?: number;
  readonly offset?: number;
}

interface CreateTicketInput {
  readonly userId: string;
  readonly subject: string;
}

interface AddMessageInput {
  readonly ticketId: string;
  readonly authorType: 'USER' | 'ADMIN';
  readonly authorId: string | null;
  readonly content: string;
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
      status: query.status,
    };
    if (query.userTelegramId !== undefined) {
      where.user = { telegramId: query.userTelegramId };
    }
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const [items, total] = await Promise.all([
      this.prismaService.supportTicket.findMany({
        where,
        include: {
          messages: { orderBy: { createdAt: 'asc' }, take: 1 },
          user: { select: { id: true, telegramId: true, name: true, username: true, email: true } },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prismaService.supportTicket.count({ where }),
    ]);
    return { items, total };
  }

  public async getById(ticketId: string) {
    const ticket = await this.prismaService.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        user: { select: { id: true, telegramId: true, name: true, username: true, email: true } },
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
    return message;
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
