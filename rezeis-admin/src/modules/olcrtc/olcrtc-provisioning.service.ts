import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';

import { appConfig } from '../../common/config/app.config';
import { olcrtcConfig } from '../../common/config/olcrtc.config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { buildUserReferenceWhere, requireUserReference } from '../internal-user/utils/user-reference.util';
import { OlcrtcSubscriptionPayload } from './interfaces/olcrtc-subscription.interface';
import { encryptOlcrtcSecret, decryptOlcrtcSecret } from './utils/olcrtc-secret-cipher';
import {
  buildOlcrtcSubscriptionText,
  buildOlcrtcSubscriptionUri,
} from './utils/olcrtc-subscription-uri.util';

type DynamicPrisma = PrismaService & {
  readonly olcProfile: DynamicDelegate;
  readonly olcGateway: DynamicDelegate;
  readonly olcRoom: DynamicDelegate;
  readonly olcSession: DynamicDelegate;
  readonly olcTrafficLedger: DynamicDelegate;
};

interface DynamicDelegate {
  findFirst(args: unknown): Promise<Record<string, unknown> | null>;
  create(args: unknown): Promise<Record<string, unknown>>;
  update(args: unknown): Promise<Record<string, unknown>>;
  upsert(args: unknown): Promise<Record<string, unknown>>;
}

interface IdentityInput {
  readonly userId?: string | null;
  readonly telegramId?: string | null;
}

const ACTIVE_SESSION_STATUSES = ['PROVISIONING', 'PENDING_AGENT', 'STARTING', 'ACTIVE', 'IDLE'] as const;

@Injectable()
export class OlcrtcProvisioningService {
  public constructor(
    private readonly prismaService: PrismaService,
    @Inject(appConfig.KEY)
    private readonly appConfiguration: ConfigType<typeof appConfig>,
    @Inject(olcrtcConfig.KEY)
    private readonly olcrtcConfiguration: ConfigType<typeof olcrtcConfig>,
  ) {}

  public async getSubscription(input: IdentityInput): Promise<OlcrtcSubscriptionPayload> {
    if (!this.olcrtcConfiguration.enabled) {
      return disabledPayload();
    }

    const user = await this.resolveUser(input);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const subscription = await this.findActiveSubscription(user.id);
    if (!subscription) {
      return {
        enabled: true,
        eligible: false,
        status: 'NO_ACTIVE_SUBSCRIPTION',
        reason: 'no_active_subscription',
        subscription: null,
      };
    }

    const existing = await this.findExistingSession(subscription.id);
    if (existing) {
      return this.sessionPayload(existing, subscription.expiresAt ?? null);
    }

    return this.createSessionSubscription(user.id, subscription.id, subscription.expiresAt ?? null);
  }

  public async provisionSubscription(input: IdentityInput): Promise<OlcrtcSubscriptionPayload> {
    return this.getSubscription(input);
  }

  public async recordGatewayHeartbeat(input: {
    readonly name: string;
    readonly managementUrl: string;
    readonly version?: string;
    readonly capacity: number;
    readonly activeSessions: number;
    readonly health?: Record<string, unknown>;
    readonly metadata?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const prisma = this.prismaService as DynamicPrisma;
    return prisma.olcGateway.upsert({
      where: { name: input.name },
      create: {
        name: input.name,
        managementUrl: input.managementUrl,
        status: 'ACTIVE',
        capacity: input.capacity,
        activeSessions: input.activeSessions,
        version: input.version ?? null,
        lastSeenAt: new Date(),
        health: input.health ?? {},
        metadata: input.metadata ?? {},
      },
      update: {
        managementUrl: input.managementUrl,
        status: 'ACTIVE',
        capacity: input.capacity,
        activeSessions: input.activeSessions,
        version: input.version ?? null,
        lastSeenAt: new Date(),
        health: input.health ?? {},
        metadata: input.metadata ?? {},
      },
    });
  }

  public async claimAgentSession(input: {
    readonly gatewayName: string;
  }): Promise<Record<string, unknown> | null> {
    const prisma = this.prismaService as DynamicPrisma;
    const gateway = await prisma.olcGateway.findFirst({
      where: { name: input.gatewayName, status: 'ACTIVE' },
    });
    if (!gateway) {
      throw new NotFoundException('OLCRTC gateway not found');
    }

    const session = await prisma.olcSession.findFirst({
      where: { gatewayId: String(gateway.id), status: 'PENDING_AGENT' },
      orderBy: { createdAt: 'asc' },
    });
    if (!session) return null;

    const agentSessionId = randomBytes(16).toString('hex');
    const claimed = await prisma.olcSession.update({
      where: { id: String(session.id) },
      data: {
        status: 'STARTING',
        agentSessionId,
        startedAt: new Date(),
        lastSeenAt: new Date(),
        metadata: mergeMetadata(session.metadata, { claimedBy: input.gatewayName }),
      },
    });
    const room = await prisma.olcRoom.findFirst({
      where: { leaseSessionId: String(claimed.id) },
    });

    return {
      sessionId: String(claimed.id),
      agentSessionId,
      userId: String(claimed.userId),
      subscriptionId: String(claimed.subscriptionId),
      profileId: String(claimed.profileId),
      provider: String(claimed.provider).toLowerCase(),
      transport: String(claimed.transport).toLowerCase(),
      cryptoKey: decryptOlcrtcSecret(String(claimed.cryptoKeyEnc), this.appConfiguration.cryptKey),
      subscriptionUri: claimed.subscriptionUri ?? null,
      room: room
        ? {
            id: String(room.id),
            externalRoomId: String(room.externalRoomId),
            externalUrl: typeof room.externalUrl === 'string' ? room.externalUrl : null,
          }
        : null,
      expiresAt: normalizeDate(claimed.expiresAt as Date | string | null)?.toISOString() ?? null,
    };
  }

  public async reportAgentSession(
    sessionId: string,
    input: {
      readonly status: 'STARTING' | 'ACTIVE' | 'IDLE' | 'FAILED' | 'STOPPED';
      readonly agentSessionId?: string;
      readonly lastError?: string;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const prisma = this.prismaService as DynamicPrisma;
    const session = await prisma.olcSession.findFirst({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('OLCRTC session not found');

    return prisma.olcSession.update({
      where: { id: sessionId },
      data: {
        status: input.status,
        agentSessionId: input.agentSessionId ?? session.agentSessionId ?? null,
        lastError: input.lastError ?? null,
        lastSeenAt: new Date(),
        stoppedAt: ['FAILED', 'STOPPED'].includes(input.status) ? new Date() : session.stoppedAt ?? null,
        metadata: mergeMetadata(session.metadata, input.metadata ?? {}),
      },
    });
  }

  public async recordTraffic(
    sessionId: string,
    input: {
      readonly rxBytes: string;
      readonly txBytes: string;
      readonly source: string;
      readonly idempotencyKey?: string;
      readonly observedAt?: string;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const prisma = this.prismaService as DynamicPrisma;
    const data = {
      sessionId,
      rxBytes: BigInt(input.rxBytes),
      txBytes: BigInt(input.txBytes),
      source: input.source,
      observedAt: input.observedAt ? new Date(input.observedAt) : new Date(),
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: input.metadata ?? {},
    };
    const ledger = input.idempotencyKey
      ? await prisma.olcTrafficLedger.upsert({
          where: { idempotencyKey: input.idempotencyKey },
          create: data,
          update: {},
        })
      : await prisma.olcTrafficLedger.create({ data });
    return {
      id: String(ledger.id),
      sessionId: String(ledger.sessionId),
      rxBytes: String(ledger.rxBytes),
      txBytes: String(ledger.txBytes),
      source: String(ledger.source),
      observedAt: normalizeDate(ledger.observedAt as Date | string)?.toISOString() ?? null,
      idempotencyKey: ledger.idempotencyKey ?? null,
    };
  }

  private async createSessionSubscription(
    userId: string,
    subscriptionId: string,
    expiresAt: Date | string | null,
  ): Promise<OlcrtcSubscriptionPayload> {
    const prisma = this.prismaService as DynamicPrisma;
    const profile = await prisma.olcProfile.findFirst({
      where: { isEnabled: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    if (!profile) return unavailablePayload('no_enabled_profile');

    const gateway = await prisma.olcGateway.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: [{ activeSessions: 'asc' }, { createdAt: 'asc' }],
    });
    if (!gateway) return unavailablePayload('no_active_gateway');

    const room = await this.allocateRoom(profile, userId);
    if (!room) return unavailablePayload('no_ready_room');

    const cryptoKey = randomBytes(32).toString('hex');
    const subscriptionUri = buildOlcrtcSubscriptionUri({
      provider: String(profile.provider),
      transport: String(profile.transport),
      roomId: String(room.externalRoomId),
      cryptoKey,
      name: String(profile.name),
      transportOptions: asRecord(profile.transportOptions),
    });
    const subscriptionText = buildOlcrtcSubscriptionText(
      subscriptionUri,
      this.olcrtcConfiguration.subscriptionName,
      this.olcrtcConfiguration.defaultRefreshSeconds,
    );

    const session = await prisma.olcSession.create({
      data: {
        userId,
        subscriptionId,
        profileId: String(profile.id),
        gatewayId: String(gateway.id),
        status: 'PENDING_AGENT',
        provider: profile.provider,
        transport: profile.transport,
        cryptoKeyEnc: encryptOlcrtcSecret(cryptoKey, this.appConfiguration.cryptKey),
        cryptoKeyFingerprint: createHash('sha256').update(cryptoKey).digest('hex'),
        subscriptionUri: subscriptionText,
        expiresAt: normalizeDate(expiresAt),
        metadata: { provisionedBy: 'rezeis', runtime: 'pending_agent' },
      },
    });
    await prisma.olcRoom.update({
      where: { id: String(room.id) },
      data: { status: 'IN_USE', leaseSessionId: String(session.id) },
    });

    return this.sessionPayload(session, expiresAt);
  }

  private async resolveUser(input: IdentityInput): Promise<{ readonly id: string } | null> {
    const reference = requireUserReference(input);
    return this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(reference),
      select: { id: true },
    });
  }

  private async findActiveSubscription(userId: string): Promise<{
    readonly id: string;
    readonly expiresAt: Date | null;
  } | null> {
    return this.prismaService.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true, expiresAt: true },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'desc' }],
    });
  }

  private async findExistingSession(subscriptionId: string): Promise<Record<string, unknown> | null> {
    const prisma = this.prismaService as DynamicPrisma;
    return prisma.olcSession.findFirst({
      where: {
        subscriptionId,
        status: { in: [...ACTIVE_SESSION_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async allocateRoom(
    profile: Record<string, unknown>,
    userId: string,
  ): Promise<Record<string, unknown> | null> {
    const prisma = this.prismaService as DynamicPrisma;
    const existing = await prisma.olcRoom.findFirst({
      where: {
        profileId: String(profile.id),
        status: 'READY',
        leaseSessionId: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) return existing;

    if (profile.provider !== 'JITSI') return null;
    const roomId = this.buildJitsiRoomId(profile);
    return prisma.olcRoom.create({
      data: {
        provider: 'JITSI',
        externalRoomId: roomId,
        externalUrl: roomId.startsWith('https://') ? roomId : null,
        status: 'READY',
        profileId: String(profile.id),
        createdForUserId: userId,
        metadata: { autoRoom: true },
      },
    });
  }

  private buildJitsiRoomId(profile: Record<string, unknown>): string {
    const suffix = randomBytes(12).toString('hex');
    const template = typeof profile.roomTemplate === 'string' ? profile.roomTemplate.trim() : '';
    if (!template) return `https://meet.jit.si/rezeis-olc-${suffix}`;
    if (template.includes('{random}')) return template.replaceAll('{random}', suffix);
    return `${template.replace(/\/+$/u, '')}/${suffix}`;
  }

  private sessionPayload(
    session: Record<string, unknown>,
    expiresAt: Date | string | null,
  ): OlcrtcSubscriptionPayload {
    const url = typeof session.subscriptionUri === 'string' ? session.subscriptionUri : null;
    if (!url) throw new BadRequestException('OLCRTC session has no subscription URI');
    if (typeof session.cryptoKeyEnc === 'string') {
      decryptOlcrtcSecret(session.cryptoKeyEnc, this.appConfiguration.cryptKey);
    }
    return {
      enabled: true,
      eligible: true,
      status: 'READY',
      subscription: {
        sessionId: String(session.id),
        subscriptionId: String(session.subscriptionId),
        profileId: String(session.profileId),
        provider: String(session.provider).toLowerCase(),
        transport: String(session.transport).toLowerCase(),
        url,
        refreshSeconds: this.olcrtcConfiguration.defaultRefreshSeconds,
        expiresAt: normalizeDate(expiresAt)?.toISOString() ?? null,
      },
    };
  }
}

function disabledPayload(): OlcrtcSubscriptionPayload {
  return { enabled: false, eligible: false, status: 'DISABLED', reason: 'olcrtc_disabled', subscription: null };
}

function unavailablePayload(reason: string): OlcrtcSubscriptionPayload {
  return { enabled: true, eligible: true, status: 'UNAVAILABLE', reason, subscription: null };
}

function normalizeDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mergeMetadata(
  current: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...asRecord(current), ...patch };
}
