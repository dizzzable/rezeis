import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ListAuditEventsV2QueryDto } from '../dto/list-audit-events.dto';
import { ListAdminAuditEventsQueryDto } from '../dto/list-admin-audit-events-query.dto';
import {
  AdminAuditActorInterface,
  AdminAuditEventInterface,
} from '../interfaces/admin-audit-event.interface';
import {
  AuditEventListV2Result,
  AuditEventV2Interface,
  AuditFacetsInterface,
} from '../interfaces/audit-event-v2.interface';

const AUDIT_EVENT_INCLUDE = {
  adminUser: {
    select: {
      id: true,
      login: true,
      email: true,
      name: true,
    },
  },
} as const;

type AuditEventRecord = Prisma.AdminAuditLogGetPayload<{
  include: typeof AUDIT_EVENT_INCLUDE;
}>;

const FACET_LIMIT = 100;

/**
 * Audit log read service.
 *
 * Two contracts are supported simultaneously:
 *   - Legacy `/admin/audit/events` (action / adminUserId / metadata).
 *   - V2 `/admin/audit` consumed by the React UI (kind / actorId /
 *     payload + cursor pagination + facets).
 *
 * Writes happen inline at the call sites that emit events
 * (auth flows, settings updates, payment ops). The shared event bus
 * lives in `SystemEventsService.emit()`.
 */
@Injectable()
export class AuditService {
  public constructor(private readonly prismaService: PrismaService) {}

  // ── Legacy contract ────────────────────────────────────────────────────

  public async listEvents(
    query: ListAdminAuditEventsQueryDto,
  ): Promise<readonly AdminAuditEventInterface[]> {
    const where: Prisma.AdminAuditLogWhereInput = {
      action: query.action,
      adminUserId: query.adminUserId,
    };
    if (query.from !== undefined || query.to !== undefined) {
      where.createdAt = {
        gte: query.from === undefined ? undefined : new Date(query.from),
        lte: query.to === undefined ? undefined : new Date(query.to),
      };
    }
    const events: AuditEventRecord[] = await this.prismaService.adminAuditLog.findMany({
      where,
      include: AUDIT_EVENT_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit ?? 100,
      skip: query.offset ?? 0,
    });
    return events.map(mapAuditEvent);
  }

  // ── V2 contract ────────────────────────────────────────────────────────

  public async listEventsV2(
    query: ListAuditEventsV2QueryDto,
  ): Promise<AuditEventListV2Result> {
    const limit = query.limit ?? 50;
    const where: Prisma.AdminAuditLogWhereInput = {};
    if (query.kind) where.action = query.kind;
    if (query.systemOnly === 'true' && !query.kind) {
      // System-events feed: only rows emitted by SystemEventsService, which
      // persist with an `event.<type>` action prefix.
      where.action = { startsWith: 'event.' };
    }
    if (query.actorId) {
      where.adminUserId = query.actorId === 'system' ? null : query.actorId;
    }
    if (query.targetType) {
      where.metadata = {
        path: ['targetType'],
        equals: query.targetType,
      } as Prisma.JsonFilter;
    }
    if (query.q) {
      // Search across action / username / metadata-as-text. JSON-as-text
      // contains() needs `string_filter` so we OR the obvious text columns.
      where.OR = [
        { action: { contains: query.q, mode: 'insensitive' } },
        {
          adminUser: {
            OR: [
              { login: { contains: query.q, mode: 'insensitive' } },
              { email: { contains: query.q, mode: 'insensitive' } },
              { name: { contains: query.q, mode: 'insensitive' } },
            ],
          },
        },
      ];
    }

    if (query.cursor) {
      const last = await this.prismaService.adminAuditLog.findUnique({
        where: { id: query.cursor },
        select: { id: true, createdAt: true },
      });
      if (last) {
        const seek: Prisma.AdminAuditLogWhereInput = {
          OR: [
            { createdAt: { lt: last.createdAt } },
            { createdAt: last.createdAt, id: { lt: last.id } },
          ],
        };
        where.AND = where.AND
          ? [...(Array.isArray(where.AND) ? where.AND : [where.AND]), seek]
          : seek;
      }
    }

    const rows = await this.prismaService.adminAuditLog.findMany({
      where,
      include: AUDIT_EVENT_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const items = rows.slice(0, limit).map(mapAuditEventV2);
    const nextCursor = rows.length > limit ? items[items.length - 1].id : null;
    return { items, nextCursor };
  }

  /**
   * Distinct values used to populate the filter dropdowns. Bounded at
   * `FACET_LIMIT` so the call stays cheap on large audit tables.
   */
  public async getFacets(): Promise<AuditFacetsInterface> {
    const [kindRows, actorRows, targetRows] = await Promise.all([
      this.prismaService.adminAuditLog.findMany({
        select: { action: true },
        distinct: ['action'],
        orderBy: { action: 'asc' },
        take: FACET_LIMIT,
      }),
      this.prismaService.adminAuditLog.findMany({
        where: { adminUser: { isNot: null } },
        select: { adminUser: { select: { login: true } } },
        distinct: ['adminUserId'],
        orderBy: { createdAt: 'desc' },
        take: FACET_LIMIT,
      }),
      this.prismaService.$queryRaw<{ targetType: string | null }[]>(
        Prisma.sql`
          SELECT DISTINCT metadata->>'targetType' AS "targetType"
          FROM admin_audit_log
          WHERE metadata->>'targetType' IS NOT NULL
          ORDER BY "targetType" ASC
          LIMIT ${FACET_LIMIT}
        `,
      ),
    ]);
    return {
      kinds: kindRows.map((r) => r.action),
      actors: actorRows
        .map((r) => r.adminUser?.login)
        .filter((v): v is string => typeof v === 'string'),
      targetTypes: targetRows
        .map((r) => r.targetType)
        .filter((v): v is string => typeof v === 'string'),
    };
  }
}

function mapAuditEvent(event: AuditEventRecord): AdminAuditEventInterface {
  return {
    id: event.id,
    action: event.action,
    actor: mapActor(event.adminUser),
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    metadata: normalizeMetadata(event.metadata),
    createdAt: event.createdAt.toISOString(),
  };
}

function mapAuditEventV2(event: AuditEventRecord): AuditEventV2Interface {
  const metadata = normalizeMetadata(event.metadata);
  const targetType = typeof metadata['targetType'] === 'string'
    ? (metadata['targetType'] as string)
    : null;
  const targetId = typeof metadata['targetId'] === 'string'
    ? (metadata['targetId'] as string)
    : null;
  // Strip targetType/targetId from the payload — the UI shows them in
  // their own column. Anything else stays in `payload`.
  const { targetType: _t, targetId: _tid, ...payloadRest } = metadata;
  return {
    id: event.id,
    kind: event.action,
    actorId: event.adminUserId ?? null,
    actorIp: event.ipAddress,
    targetType,
    targetId,
    payload: Object.keys(payloadRest).length > 0 ? payloadRest : null,
    createdAt: event.createdAt.toISOString(),
  };
}

function mapActor(
  actor: AuditEventRecord['adminUser'],
): AdminAuditActorInterface | null {
  if (actor === null) {
    return null;
  }
  return {
    id: actor.id,
    login: actor.login,
    email: actor.email,
    name: actor.name,
  };
}

function normalizeMetadata(value: Prisma.JsonValue): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
