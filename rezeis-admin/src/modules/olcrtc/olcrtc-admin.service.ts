import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { appConfig } from '../../common/config/app.config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OlcrtcUpdateGatewayDto } from './dto/olcrtc-admin-gateway.dto';
import { OlcrtcCreateProfileDto, OlcrtcUpdateProfileDto } from './dto/olcrtc-admin-profile.dto';
import { OlcrtcCreateProviderAccountDto, OlcrtcUpdateProviderAccountDto } from './dto/olcrtc-admin-provider-account.dto';
import { OlcrtcUpdateRoomDto } from './dto/olcrtc-admin-room.dto';
import { OlcrtcUpdateSessionDto } from './dto/olcrtc-admin-session.dto';
import { OlcrtcAdminTrafficQueryDto } from './dto/olcrtc-admin-traffic-query.dto';
import { OlcrtcLifecycleResult, OlcrtcLifecycleService } from './olcrtc-lifecycle.service';
import { encryptOlcrtcSecret } from './utils/olcrtc-secret-cipher';

interface ReadDelegate {
  findMany(args: unknown): Promise<readonly Record<string, unknown>[]>;
  count(args?: unknown): Promise<number>;
  create?(args: unknown): Promise<Record<string, unknown>>;
  update?(args: unknown): Promise<Record<string, unknown>>;
}

type OlcrtcAdminPrisma = PrismaService & {
  readonly olcProviderAccount: ReadDelegate;
  readonly olcProfile: ReadDelegate;
  readonly olcGateway: ReadDelegate;
  readonly olcRoom: ReadDelegate;
  readonly olcSession: ReadDelegate;
  readonly olcTrafficLedger: ReadDelegate;
};

export interface OlcrtcAdminOverview {
  readonly providerAccounts: readonly Record<string, unknown>[];
  readonly profiles: readonly Record<string, unknown>[];
  readonly gateways: readonly Record<string, unknown>[];
  readonly rooms: readonly Record<string, unknown>[];
  readonly sessions: readonly Record<string, unknown>[];
  readonly counts: Record<string, number>;
}

export interface OlcrtcTrafficLedgerItem {
  readonly id: string;
  readonly sessionId: string;
  readonly rxBytes: string;
  readonly txBytes: string;
  readonly source: string;
  readonly observedAt: string;
  readonly idempotencyKey: string | null;
  readonly metadata: unknown;
  readonly createdAt: string;
}

@Injectable()
export class OlcrtcAdminService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly lifecycleService: OlcrtcLifecycleService,
    @Inject(appConfig.KEY)
    private readonly appConfiguration: ConfigType<typeof appConfig>,
  ) {}

  public async getOverview(): Promise<OlcrtcAdminOverview> {
    const prisma = this.prismaService as OlcrtcAdminPrisma;
    const [providerAccounts, profiles, gateways, rooms, sessions, trafficLedgerCount] = await Promise.all([
      prisma.olcProviderAccount.findMany({
        select: {
          id: true,
          provider: true,
          name: true,
          credentialHint: true,
          isEnabled: true,
          lastValidatedAt: true,
          lastValidationError: true,
          metadata: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ provider: 'asc' }, { name: 'asc' }],
      }),
      prisma.olcProfile.findMany({
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      }),
      prisma.olcGateway.findMany({
        orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }, { name: 'asc' }],
      }),
      prisma.olcRoom.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.olcSession.findMany({
        select: {
          id: true,
          userId: true,
          subscriptionId: true,
          profileId: true,
          gatewayId: true,
          status: true,
          provider: true,
          transport: true,
          agentSessionId: true,
          lastError: true,
          startedAt: true,
          expiresAt: true,
          lastSeenAt: true,
          stoppedAt: true,
          metadata: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.olcTrafficLedger.count(),
    ]);

    const counts = await this.countByStatus(prisma);
    return {
      providerAccounts,
      profiles,
      gateways,
      rooms,
      sessions,
      counts: { ...counts, trafficLedger: trafficLedgerCount },
    };
  }

  public runLifecycleOnce(): Promise<OlcrtcLifecycleResult> {
    return this.lifecycleService.runOnce();
  }

  public async createProviderAccount(
    input: OlcrtcCreateProviderAccountDto,
  ): Promise<Record<string, unknown>> {
    const prisma = this.prismaService as OlcrtcAdminPrisma;
    return requireWrite(prisma.olcProviderAccount, 'olcProviderAccount').create({
      data: {
        provider: input.provider,
        name: input.name,
        credentialsEnc: input.credentials
          ? this.encryptCredentials(input.credentials)
          : null,
        credentialHint: input.credentialHint ?? credentialHint(input.credentials),
        isEnabled: input.isEnabled ?? true,
        metadata: input.metadata ?? {},
      },
      select: PROVIDER_ACCOUNT_SAFE_SELECT,
    });
  }

  public async updateProviderAccount(
    id: string,
    input: OlcrtcUpdateProviderAccountDto,
  ): Promise<Record<string, unknown>> {
    const prisma = this.prismaService as OlcrtcAdminPrisma;
    const data: Record<string, unknown> = {};
    if (input.provider !== undefined) data.provider = input.provider;
    if (input.name !== undefined) data.name = input.name;
    if (input.credentials !== undefined) {
      data.credentialsEnc = input.credentials === null ? null : this.encryptCredentials(input.credentials);
      data.credentialHint = input.credentialHint ?? credentialHint(input.credentials);
    } else if (input.credentialHint !== undefined) {
      data.credentialHint = input.credentialHint;
    }
    if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;
    if (input.metadata !== undefined) data.metadata = input.metadata;

    return requireWrite(prisma.olcProviderAccount, 'olcProviderAccount').update({
      where: { id },
      data,
      select: PROVIDER_ACCOUNT_SAFE_SELECT,
    });
  }

  public async createProfile(input: OlcrtcCreateProfileDto): Promise<Record<string, unknown>> {
    const prisma = this.prismaService as OlcrtcAdminPrisma;
    return requireWrite(prisma.olcProfile, 'olcProfile').create({
      data: {
        name: input.name,
        provider: input.provider,
        transport: input.transport,
        providerAccountId: input.providerAccountId ?? null,
        roomTemplate: input.roomTemplate ?? null,
        transportOptions: input.transportOptions ?? {},
        priority: input.priority ?? 100,
        isEnabled: input.isEnabled ?? true,
        metadata: input.metadata ?? {},
      },
    });
  }

  public async updateProfile(
    id: string,
    input: OlcrtcUpdateProfileDto,
  ): Promise<Record<string, unknown>> {
    const prisma = this.prismaService as OlcrtcAdminPrisma;
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.provider !== undefined) data.provider = input.provider;
    if (input.transport !== undefined) data.transport = input.transport;
    if (input.providerAccountId !== undefined) data.providerAccountId = input.providerAccountId;
    if (input.roomTemplate !== undefined) data.roomTemplate = input.roomTemplate;
    if (input.transportOptions !== undefined) data.transportOptions = input.transportOptions;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;
    if (input.metadata !== undefined) data.metadata = input.metadata;

    return requireWrite(prisma.olcProfile, 'olcProfile').update({ where: { id }, data });
  }

  public async updateGateway(
    id: string,
    input: OlcrtcUpdateGatewayDto,
  ): Promise<Record<string, unknown>> {
    const prisma = this.prismaService as OlcrtcAdminPrisma;
    const data: Record<string, unknown> = {};
    if (input.managementUrl !== undefined) data.managementUrl = input.managementUrl;
    if (input.status !== undefined) data.status = input.status;
    if (input.capacity !== undefined) data.capacity = input.capacity;
    if (input.version !== undefined) data.version = input.version;
    if (input.health !== undefined) data.health = input.health;
    if (input.metadata !== undefined) data.metadata = input.metadata;

    return requireWrite(prisma.olcGateway, 'olcGateway').update({ where: { id }, data });
  }

  public async updateRoom(id: string, input: OlcrtcUpdateRoomDto): Promise<Record<string, unknown>> {
    const prisma = this.prismaService as OlcrtcAdminPrisma;
    const data: Record<string, unknown> = {};
    if (input.status !== undefined) data.status = input.status;
    if (input.leaseSessionId !== undefined) data.leaseSessionId = input.leaseSessionId;
    if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
    if (input.lastVerifiedAt !== undefined) {
      data.lastVerifiedAt = input.lastVerifiedAt === null ? null : new Date(input.lastVerifiedAt);
    }
    if (input.metadata !== undefined) data.metadata = input.metadata;

    return requireWrite(prisma.olcRoom, 'olcRoom').update({ where: { id }, data });
  }

  public async updateSession(
    id: string,
    input: OlcrtcUpdateSessionDto,
  ): Promise<Record<string, unknown>> {
    const prisma = this.prismaService as OlcrtcAdminPrisma;
    const data: Record<string, unknown> = {};
    if (input.status !== undefined) data.status = input.status;
    if (input.lastError !== undefined) data.lastError = input.lastError;
    if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
    if (input.stoppedAt !== undefined) data.stoppedAt = input.stoppedAt === null ? null : new Date(input.stoppedAt);
    if (input.metadata !== undefined) data.metadata = input.metadata;
    if (isTerminalSessionStatus(input.status) && input.stoppedAt === undefined) {
      data.stoppedAt = new Date();
    }

    return requireWrite(prisma.olcSession, 'olcSession').update({ where: { id }, data });
  }

  public async listTrafficLedger(
    query: OlcrtcAdminTrafficQueryDto,
  ): Promise<{ readonly items: readonly OlcrtcTrafficLedgerItem[] }> {
    const prisma = this.prismaService as OlcrtcAdminPrisma;
    const rows = await prisma.olcTrafficLedger.findMany({
      where: query.sessionId ? { sessionId: query.sessionId } : {},
      orderBy: { observedAt: 'desc' },
      take: query.take ?? 100,
    });
    return { items: rows.map(toTrafficLedgerItem) };
  }

  private async countByStatus(prisma: OlcrtcAdminPrisma): Promise<Record<string, number>> {
    const [gateways, activeGateways, unhealthyGateways, sessions, activeSessions, failedSessions, rooms, inUseRooms] = await Promise.all([
      prisma.olcGateway.count(),
      prisma.olcGateway.count({ where: { status: 'ACTIVE' } }),
      prisma.olcGateway.count({ where: { status: 'UNHEALTHY' } }),
      prisma.olcSession.count(),
      prisma.olcSession.count({ where: { status: { in: ['ACTIVE', 'IDLE', 'STARTING'] } } }),
      prisma.olcSession.count({ where: { status: 'FAILED' } }),
      prisma.olcRoom.count(),
      prisma.olcRoom.count({ where: { status: 'IN_USE' } }),
    ]);
    return {
      gateways,
      activeGateways,
      unhealthyGateways,
      sessions,
      activeSessions,
      failedSessions,
      rooms,
      inUseRooms,
    };
  }

  private encryptCredentials(credentials: Record<string, unknown>): string {
    return encryptOlcrtcSecret(JSON.stringify(credentials), this.appConfiguration.cryptKey);
  }
}

const PROVIDER_ACCOUNT_SAFE_SELECT = {
  id: true,
  provider: true,
  name: true,
  credentialHint: true,
  isEnabled: true,
  lastValidatedAt: true,
  lastValidationError: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
} as const;

function requireWrite(delegate: ReadDelegate, name: string): Required<Pick<ReadDelegate, 'create' | 'update'>> {
  if (!delegate.create || !delegate.update) {
    throw new Error(`${name} delegate is not writable`);
  }
  return delegate as Required<Pick<ReadDelegate, 'create' | 'update'>>;
}

function isTerminalSessionStatus(status: string | undefined): boolean {
  return status === 'STOPPED' || status === 'FAILED' || status === 'EXPIRED';
}

function toTrafficLedgerItem(row: Record<string, unknown>): OlcrtcTrafficLedgerItem {
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    rxBytes: String(row.rxBytes),
    txBytes: String(row.txBytes),
    source: String(row.source),
    observedAt: normalizeDate(row.observedAt).toISOString(),
    idempotencyKey: typeof row.idempotencyKey === 'string' ? row.idempotencyKey : null,
    metadata: row.metadata ?? {},
    createdAt: normalizeDate(row.createdAt).toISOString(),
  };
}

function normalizeDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function credentialHint(credentials: Record<string, unknown> | null | undefined): string | null {
  if (!credentials) return null;
  const keys = Object.keys(credentials).sort();
  return keys.length > 0 ? `keys:${keys.join(',')}` : null;
}
