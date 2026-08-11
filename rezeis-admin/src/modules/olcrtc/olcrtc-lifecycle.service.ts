import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../common/runtime/process-role.util';

interface CountResult {
  readonly count: number;
}

interface UpdateManyDelegate {
  updateMany(args: unknown): Promise<CountResult>;
}

type LifecyclePrisma = PrismaService & {
  readonly olcGateway: UpdateManyDelegate;
  readonly olcSession: UpdateManyDelegate;
  readonly olcRoom: UpdateManyDelegate;
};

export interface OlcrtcLifecycleResult {
  readonly staleGateways: number;
  readonly expiredSessions: number;
  readonly stuckSessions: number;
  readonly expiredRooms: number;
}

const STALE_GATEWAY_AFTER_MS = 2 * 60 * 1000;
const STUCK_SESSION_AFTER_MS = 15 * 60 * 1000;

@Injectable()
export class OlcrtcLifecycleService {
  private readonly logger = new Logger(OlcrtcLifecycleService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'olcrtc-lifecycle' })
  public async tick(): Promise<void> {
    if (!shouldRunSchedules()) return;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error('OLCRTC lifecycle sweep failed', error instanceof Error ? error.stack : undefined);
    }
  }

  public async runOnce(now = new Date()): Promise<OlcrtcLifecycleResult> {
    const prisma = this.prismaService as LifecyclePrisma;
    const staleGatewayCutoff = new Date(now.getTime() - STALE_GATEWAY_AFTER_MS);
    const stuckSessionCutoff = new Date(now.getTime() - STUCK_SESSION_AFTER_MS);

    const staleGateways = await prisma.olcGateway.updateMany({
      where: {
        status: 'ACTIVE',
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: staleGatewayCutoff } }],
      },
      data: { status: 'UNHEALTHY' },
    });

    const expiredSessions = await prisma.olcSession.updateMany({
      where: {
        status: { in: ['PROVISIONING', 'PENDING_AGENT', 'STARTING', 'ACTIVE', 'IDLE'] },
        expiresAt: { not: null, lt: now },
      },
      data: { status: 'EXPIRED', stoppedAt: now, lastSeenAt: now },
    });

    const stuckSessions = await prisma.olcSession.updateMany({
      where: {
        status: { in: ['PROVISIONING', 'PENDING_AGENT', 'STARTING'] },
        createdAt: { lt: stuckSessionCutoff },
      },
      data: {
        status: 'FAILED',
        lastError: 'OLCRTC agent did not claim/start the session in time',
        stoppedAt: now,
        lastSeenAt: now,
      },
    });

    const expiredRooms = await prisma.olcRoom.updateMany({
      where: {
        status: { in: ['READY', 'IN_USE'] },
        expiresAt: { not: null, lt: now },
      },
      data: { status: 'EXPIRED', leaseSessionId: null },
    });

    return {
      staleGateways: staleGateways.count,
      expiredSessions: expiredSessions.count,
      stuckSessions: stuckSessions.count,
      expiredRooms: expiredRooms.count,
    };
  }
}
