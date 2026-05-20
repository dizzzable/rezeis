import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { UserRealtimeEventInterface } from '../interfaces/user-realtime-event.interface';
import { UserRealtimeService } from '../services/user-realtime.service';

const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Server-Sent Events stream for user-facing realtime updates.
 *
 * Auth model
 *   The endpoint sits under `/api/internal/...` and is therefore
 *   protected by `InternalAdminAuthGuard` — only callers holding a
 *   valid api_token (i.e. reiwa) may open the stream. Reiwa proves the
 *   user identity via the `:telegramId` URL parameter, which it has
 *   already validated through its own session middleware.
 *
 * Why SSE, not WebSocket?
 *   - Single direction (server → user). The user never publishes events
 *     back through this channel; everything is initiated by the admin
 *     side via SystemEventsService.
 *   - Plays nicely with HTTP/1.1 reverse proxies (nginx + Caddy in our
 *     compose stack pass long-lived GETs without protocol negotiation).
 *   - Cheaper to operate in BFF mode — reiwa just `pipe()`s the stream
 *     to the browser without tracking WebSocket state.
 *
 * Heartbeat
 *   We push a `:keepalive` comment line every 25 s so intermediaries
 *   don't drop the idle connection.
 */
@ApiTags('internal/user/realtime')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/user')
export class InternalUserRealtimeController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly userRealtimeService: UserRealtimeService,
  ) {}

  @Get(':telegramId/stream')
  @ApiOperation({
    summary: 'Opens an SSE stream of public events scoped to a single user',
  })
  public async stream(
    @Param('telegramId') telegramIdRaw: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const telegramId = telegramIdRaw.trim();
    if (!/^\d+$/.test(telegramId)) {
      throw new BadRequestException('telegramId must be a numeric string');
    }
    const user = await this.prismaService.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: { id: true, isBlocked: true },
    });
    // We deliberately ALWAYS open the stream, even for unknown users:
    // reiwa polls subscriptions for users that may not yet have events,
    // and rejecting unknowns would leak existence. The fan-out still
    // checks `userId`/`telegramId`, so a non-existent user simply gets
    // nothing.
    const userId = user?.id ?? null;
    if (user?.isBlocked === true) {
      // Blocked users get an immediate close with `403`. We do this
      // upfront because subsequent admin events might still mention
      // them and the stream would silently leak otherwise.
      response.status(403).end();
      return;
    }

    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    // Disable nginx response buffering on the stream.
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();

    let closed = false;
    const send = (event: UserRealtimeEventInterface): void => {
      if (closed || response.writableEnded) return;
      try {
        response.write(`event: ${event.type}\n`);
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Write errors mean the socket is gone — let the close handler
        // do the cleanup.
      }
    };

    // Initial hello so the client knows the stream is live.
    send({
      type: 'realtime.ready',
      category: 'NOTIFICATION',
      severity: 'INFO',
      message: 'Realtime stream connected',
      metadata: {},
      timestamp: new Date().toISOString(),
    });

    const unsubscribe = this.userRealtimeService.subscribe({
      userId,
      telegramId,
      handler: send,
    });

    const heartbeat = setInterval(() => {
      if (closed || response.writableEnded) return;
      try {
        response.write(': keepalive\n\n');
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_INTERVAL_MS);

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };

    request.on('close', cleanup);
    response.on('close', cleanup);
    response.on('finish', cleanup);
  }
}
