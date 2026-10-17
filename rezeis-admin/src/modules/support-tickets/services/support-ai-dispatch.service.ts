import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupportTicketStatus } from '@prisma/client';
import { Queue } from 'bullmq';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  buildBoundedBullMqEnqueueOptions,
  runBullMqEnqueueWithTimeout,
} from '../../../common/queue/bullmq-enqueue-options';
import { toBullMqJobId } from '../../../common/queue/bullmq-job-id';
import { EVENT_TYPES, SystemEventsService } from '../../../common/services/system-events.service';
import { AiConfigService } from '../../ai-config/services/ai-config.service';
import {
  SUPPORT_AI_ATTEMPTS,
  SUPPORT_AI_DEBOUNCE_MS,
  SUPPORT_AI_HANDOFF,
  SUPPORT_AI_HANDOFF_WORDS,
  SUPPORT_AI_JOBS,
  SUPPORT_AI_QUEUE,
  SUPPORT_AI_REASON_MAX_CHARS,
  SUPPORT_AI_RETRY_DELAY_MS,
  type SupportAiReplyJob,
} from '../support-ai.constants';

/**
 * Who answers a client's message:
 *  - `assistant` — the AI assistant leads the thread and will answer, or it
 *    has just handed the thread over and the operators were told by that
 *    hand-over's own card. Either way the caller must NOT send the ordinary
 *    «new ticket» / «client replied» alert.
 *  - `operator` — the ordinary path: the caller alerts the operators as before.
 */
export type SupportAiRouting = 'assistant' | 'operator';

/**
 * SupportAiDispatchService
 * ════════════════════════
 * The AI assistant's side of a support ticket, minus the model: whether it
 * leads a thread, queueing its answer, and the hand-over to a human.
 *
 * ── The owner's rules (16.10.2026) ────────────────────────────────────────
 *
 *  - The separate AI chat is gone; the assistant answers IN the ticket, as
 *    ordinary support (`ADMIN` with `{ "ai": true }` in `metadata`).
 *  - The operators are called only when the assistant hands the thread over:
 *    it cannot help, the client asks for a person, it fails, or it is switched
 *    off under a thread it leads. Until then no card, no push, no bell.
 *  - An operator's own message takes the thread from the assistant
 *    (`SupportTicketsService.addMessage`).
 *
 * The model itself runs in `SupportAiModule` (`SupportAiResponderService`),
 * which depends on this module and not the other way round: the tools it
 * calls pull in the plans module, and this module must not.
 *
 * ── Who gets the assistant ───────────────────────────────────────────────
 *
 * Cabinet tickets of signed-in clients. A guest conversation (no account)
 * stays with the operators: every reply there is a letter to the visitor, and
 * an anonymous thread is the cheapest way to spend the operator's key.
 */
@Injectable()
export class SupportAiDispatchService {
  private readonly logger = new Logger(SupportAiDispatchService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly aiConfigService: AiConfigService,
    private readonly systemEvents: SystemEventsService,
    @InjectQueue(SUPPORT_AI_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Whether the assistant can answer at all: «Ассистент включён» on the AI page
   * and an API key stored. A model name is not required — the client falls
   * back to the provider's default the way the old chat did.
   */
  public async isReady(): Promise<boolean> {
    try {
      const settings = await this.aiConfigService.getSettings();
      return settings.enabled && settings.apiKey.trim().length > 0;
    } catch (err: unknown) {
      this.logger.warn(`AI settings unreadable, the assistant stays out: ${describe(err)}`);
      return false;
    }
  }

  /**
   * A client opened a cabinet ticket: hand it to the assistant when it can
   * answer, and queue the answer to the opening message.
   *
   * Returns `operator` when the assistant is off, or when its answer could not
   * be queued — then the ticket is an ordinary one and nobody is left waiting
   * on an assistant that will never speak.
   */
  public async takeNewTicket(ticketId: string, messageId: string): Promise<SupportAiRouting> {
    if (!(await this.isReady())) return 'operator';
    await this.prismaService.supportTicket.update({
      where: { id: ticketId },
      data: { aiActive: true },
    });
    if (await this.enqueueReply({ ticketId, messageId })) return 'assistant';
    await this.prismaService.supportTicket.update({ where: { id: ticketId }, data: { aiActive: false } });
    return 'operator';
  }

  /**
   * A client wrote on a ticket. When the assistant leads it, queue its answer;
   * when the assistant can no longer answer (switched off, no key, the queue
   * down), hand the thread over now — the operators are told by that card.
   */
  public async onClientMessage(ticketId: string, messageId: string): Promise<SupportAiRouting> {
    const ticket = await this.prismaService.supportTicket.findUnique({
      where: { id: ticketId },
      select: { aiActive: true },
    });
    if (ticket === null || !ticket.aiActive) return 'operator';
    if (!(await this.isReady())) {
      await this.handOff(ticketId, SUPPORT_AI_HANDOFF.OFF);
      return 'assistant';
    }
    if (!(await this.enqueueReply({ ticketId, messageId }))) {
      await this.handOff(ticketId, SUPPORT_AI_HANDOFF.ERROR);
    }
    return 'assistant';
  }

  /**
   * Pass the thread to a human and tell the operators — once.
   *
   * Compare-and-swap on `aiActive`: the assistant's own transfer, a failed
   * job and a switched-off assistant can all reach here for one ticket, and
   * only the first one to land sends the card. Returns whether this call did.
   *
   * `reason` is the panel's code ({@link SUPPORT_AI_HANDOFF}) or the
   * assistant's own sentence.
   */
  public async handOff(ticketId: string, reason: string): Promise<boolean> {
    const stored = reason.trim().slice(0, SUPPORT_AI_REASON_MAX_CHARS);
    const moved = await this.prismaService.supportTicket.updateMany({
      where: { id: ticketId, aiActive: true },
      data: { aiActive: false, aiHandedOffAt: new Date(), aiHandoffReason: stored.length > 0 ? stored : null },
    });
    if (moved.count === 0) return false;
    await this.reopenForOperator(ticketId);
    const ticket = await this.prismaService.supportTicket.findUnique({
      where: { id: ticketId },
      select: { subject: true, userId: true },
    });
    const why = SUPPORT_AI_HANDOFF_WORDS[stored] ?? stored;
    this.systemEvents.info(
      EVENT_TYPES.SUPPORT_TICKET_HANDED_OFF,
      'SUPPORT',
      `ИИ передал обращение «${ticket?.subject ?? ticketId}» оператору${why.length > 0 ? `: ${why}` : ''}`,
      { ticketId, userId: ticket?.userId ?? null, subject: ticket?.subject ?? null, reason: stored },
    );
    return true;
  }

  /**
   * Put a handed-over thread back in the operators' queue.
   *
   * Every reply of the assistant moves the ticket to `WAITING_REPLY` («ждёт
   * ответа клиента») — right after an answer, wrong after a hand-over: the
   * thread waits on a person, and in «ждёт ответа клиента» it drops out of
   * the queue an operator works from. Called by the hand-over itself and
   * again after the line that tells the client a person will answer.
   */
  public async reopenForOperator(ticketId: string): Promise<void> {
    await this.prismaService.supportTicket.updateMany({
      where: { id: ticketId, status: SupportTicketStatus.WAITING_REPLY },
      data: { status: SupportTicketStatus.OPEN },
    });
  }

  /**
   * The operator's switch on one ticket.
   *
   * Off: the assistant stops answering here, without a card — the operator is
   * already looking at the thread. On: the assistant leads it again, and when
   * the client's message is the last word it answers that message now.
   * Refused while the assistant cannot answer: a switch that turns "on" into
   * silence is the one thing the client must never meet.
   */
  public async setActive(ticketId: string, active: boolean): Promise<{ readonly aiActive: boolean }> {
    const ticket = await this.prismaService.supportTicket.findUnique({
      where: { id: ticketId },
      select: {
        id: true,
        status: true,
        userId: true,
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, authorType: true } },
      },
    });
    if (ticket === null) throw new NotFoundException('Support ticket not found');
    if (!active) {
      await this.prismaService.supportTicket.update({ where: { id: ticketId }, data: { aiActive: false } });
      return { aiActive: false };
    }
    if (ticket.userId === null) {
      throw new BadRequestException('The assistant answers only tickets of clients with an account');
    }
    if (ticket.status === SupportTicketStatus.CLOSED) {
      throw new BadRequestException('Support ticket is closed');
    }
    if (!(await this.isReady())) {
      throw new BadRequestException('The AI assistant is switched off or has no API key');
    }
    await this.prismaService.supportTicket.update({
      where: { id: ticketId },
      data: { aiActive: true, aiHandedOffAt: null, aiHandoffReason: null },
    });
    const last = ticket.messages[0];
    if (last !== undefined && last.authorType === 'USER') {
      if (!(await this.enqueueReply({ ticketId, messageId: last.id }))) {
        await this.prismaService.supportTicket.update({ where: { id: ticketId }, data: { aiActive: false } });
        throw new BadRequestException('The assistant could not be queued; try again in a minute');
      }
    }
    return { aiActive: true };
  }

  /** Queue the assistant's answer to one message. `false` when the queue refused. */
  private async enqueueReply(job: SupportAiReplyJob): Promise<boolean> {
    try {
      await runBullMqEnqueueWithTimeout(() =>
        this.queue.add(SUPPORT_AI_JOBS.REPLY, job, {
          ...buildBoundedBullMqEnqueueOptions({
            jobId: toBullMqJobId(SUPPORT_AI_JOBS.REPLY, `${job.ticketId}:${job.messageId}`),
          }),
          delay: SUPPORT_AI_DEBOUNCE_MS,
          attempts: SUPPORT_AI_ATTEMPTS,
          backoff: { type: 'fixed', delay: SUPPORT_AI_RETRY_DELAY_MS },
        }),
      );
      return true;
    } catch (err: unknown) {
      this.logger.error(`AI answer not queued for ticket ${job.ticketId}: ${describe(err)}`);
      return false;
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
