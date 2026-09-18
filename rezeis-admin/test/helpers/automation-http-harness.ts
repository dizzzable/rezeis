import 'reflect-metadata';

import type { LookupAddress } from 'node:dns';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AutomationTriggerKind, Prisma } from '@prisma/client';
import type { Express } from 'express';
import { of } from 'rxjs';
import request from 'supertest';

import { AdminSafeExceptionFilter } from '../../src/common/filters/admin-safe-exception.filter';
import { AdminJwtAuthGuard } from '../../src/modules/auth/guards/admin-jwt-auth.guard';
import { AutomationActionRegistry } from '../../src/modules/automations/actions/action-registry';
import { AutomationExecutorService } from '../../src/modules/automations/automation-executor.service';
import { AutomationsController } from '../../src/modules/automations/automations.controller';
import { AutomationsService } from '../../src/modules/automations/automations.service';
import type { AutomationNetworkProbes } from '../../src/modules/automations/services/automation-network-probes';
import { AutomationRuleAccessService } from '../../src/modules/automations/services/automation-rule-access.service';
import { BlockIpSafetyService } from '../../src/modules/automations/services/block-ip-safety.service';
import { EventCatalogService } from '../../src/modules/automations/services/event-catalog.service';
import { RbacService } from '../../src/modules/rbac/services/rbac.service';

/**
 * The automations API as it runs in production, over an in-memory database.
 *
 * REAL: the controller, `RbacGuard`, `RbacService` (reading a role's grants the
 * way it does for every admin), the global `ValidationPipe` with the options
 * `main.ts` passes, `AdminSafeExceptionFilter`, `AutomationsService`, the
 * executor, the action registry, the permission check and the lockout check.
 *
 * STAND-INS: the JWT guard (an admin is picked with the `x-test-admin` header),
 * Prisma (the maps below, which apply writes the way Prisma does), DNS and the
 * machine's network interfaces (answered from `network`), and the outbound HTTP
 * client, which records every POST instead of sending it.
 *
 * `trust proxy` is on, so a test says where a request comes from with
 * `X-Forwarded-For` and the route resolves it exactly as behind the panel's
 * reverse proxy.
 */

export interface HarnessAdmin {
  readonly id: string;
  readonly role: 'DEV' | 'ADMIN';
  /** `resource:action` tokens the admin's custom role grants. */
  readonly permissions: readonly string[];
}

export interface RuleRow {
  id: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  triggerKind: AutomationTriggerKind;
  triggerSpec: string;
  conditions: unknown;
  actions: unknown;
  createdById: string | null;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditRow {
  readonly action: string;
  readonly adminUserId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface HarnessDatabase {
  readonly rules: Map<string, RuleRow>;
  readonly audit: AuditRow[];
  readonly executions: Array<Record<string, unknown>>;
  readonly blockedIps: Map<string, Record<string, unknown>>;
  /** What the lockout check reads. */
  readonly admins: Array<{ lastLoginIp: string | null; isActive: boolean }>;
  readonly loginAttempts: Array<{ ipAddress: string; success: boolean; createdAt: Date }>;
  readonly allowlist: Array<{ address: string; isActive: boolean }>;
  /** Makes every read the lockout check does throw, as a database that is down would. */
  failAdminReads: boolean;
  /**
   * Runs once, right after the next rule read hands its copy out: what another
   * admin saving the rule at that moment would do to the row.
   */
  afterNextRuleRead: ((row: RuleRow) => void) | null;
}

export interface HarnessNetwork {
  localAddresses: string[];
  serviceHosts: string[];
  /** host → addresses it resolves to; a missing host fails with ENOTFOUND. */
  dns: Map<string, string[]>;
}

export interface AutomationHarness {
  readonly app: INestApplication;
  readonly db: HarnessDatabase;
  readonly network: HarnessNetwork;
  /** Every outbound POST the registry made. */
  readonly posts: Array<{ url: string; config: Record<string, unknown> }>;
  /** Every event the registry put on the bus, `system_event` and notifications alike. */
  readonly emitted: Array<Record<string, unknown>>;
  /** Every customer block the registry asked for. */
  readonly userBlocks: Array<Record<string, unknown>>;
  /** A request as `adminId`, from `ip`. */
  readonly as: (adminId: string, ip?: string) => AdminRequest;
  /** A stored rule, written straight into the database as an import or an old save would leave it. */
  readonly seedRule: (rule: Partial<RuleRow> & { readonly actions: unknown }) => RuleRow;
  /** The executor the routes use, for a spec that drives a run the way the event bridge does. */
  readonly executor: AutomationExecutorService;
  /** The in-memory Prisma double itself, for a spec that builds more of the module around it. */
  readonly prisma: unknown;
  readonly close: () => Promise<void>;
}

export interface AdminRequest {
  readonly get: (path: string) => request.Test;
  readonly post: (path: string, body?: object) => request.Test;
  readonly put: (path: string, body?: object) => request.Test;
  readonly patch: (path: string, body?: object) => request.Test;
  readonly delete: (path: string) => request.Test;
}

/** The address every request comes from unless a test says otherwise. */
export const DEFAULT_REQUEST_IP = '198.51.100.77';

export async function createAutomationHarness(admins: readonly HarnessAdmin[]): Promise<AutomationHarness> {
  const byId = new Map(admins.map((admin) => [admin.id, admin]));
  const db: HarnessDatabase = {
    rules: new Map(),
    audit: [],
    executions: [],
    blockedIps: new Map(),
    admins: [],
    loginAttempts: [],
    allowlist: [],
    failAdminReads: false,
    afterNextRuleRead: null,
  };
  const network: HarnessNetwork = { localAddresses: [], serviceHosts: [], dns: new Map() };
  const posts: Array<{ url: string; config: Record<string, unknown> }> = [];
  const userBlocks: Array<Record<string, unknown>> = [];
  const emitted: Array<Record<string, unknown>> = [];
  let ruleCounter = 0;
  let executionCounter = 0;

  const failIfDown = (): void => {
    if (db.failAdminReads) throw new Error('connect ECONNREFUSED 10.0.0.9:5432');
  };

  const prisma = {
    automationRule: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const copy = cloneRule(db.rules.get(where.id));
        const hook = db.afterNextRuleRead;
        const stored = db.rules.get(where.id);
        if (hook !== null && stored !== undefined) {
          db.afterNextRuleRead = null;
          hook(stored);
        }
        return copy;
      },
      findMany: async (args: FindManyArgs = {}) =>
        query([...db.rules.values()] as unknown as Array<Record<string, unknown>>, args).map((row) =>
          cloneRule(row as unknown as RuleRow),
        ),
      updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const matching = [...db.rules.values()].filter((row) =>
          matchesWhere(row as unknown as Record<string, unknown>, where),
        );
        for (const row of matching) {
          Object.assign(row, data);
          row.updatedAt = nextTimestamp(row.updatedAt);
        }
        return { count: matching.length };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        ruleCounter += 1;
        const now = new Date();
        const row: RuleRow = {
          id: `rule-${ruleCounter}`,
          name: String(data['name']),
          description: (data['description'] as string | null | undefined) ?? null,
          isEnabled: (data['isEnabled'] as boolean | undefined) ?? true,
          triggerKind: data['triggerKind'] as AutomationTriggerKind,
          triggerSpec: (data['triggerSpec'] as string | undefined) ?? '',
          conditions: jsonColumn(data['conditions']),
          actions: data['actions'] ?? [],
          createdById: (data['createdById'] as string | null | undefined) ?? null,
          lastRunAt: null,
          lastRunStatus: null,
          lastRunMessage: null,
          runCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        db.rules.set(row.id, row);
        return cloneRule(row);
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = db.rules.get(where.id);
        if (row === undefined) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
        for (const [key, value] of Object.entries(data)) {
          if (key === 'runCount' && typeof value === 'object' && value !== null) {
            row.runCount += Number((value as { increment?: number }).increment ?? 0);
          } else if (key === 'conditions') {
            row.conditions = jsonColumn(value);
          } else {
            (row as unknown as Record<string, unknown>)[key] = value;
          }
        }
        row.updatedAt = nextTimestamp(row.updatedAt);
        return cloneRule(row);
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const row = db.rules.get(where.id);
        if (row === undefined) throw Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' });
        db.rules.delete(where.id);
        return cloneRule(row);
      },
    },
    automationExecution: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        executionCounter += 1;
        const row = { id: `execution-${executionCounter}`, createdAt: new Date(), ...data };
        db.executions.push(row);
        return row;
      },
      // The run log, newest first, as `listExecutions` reads it.
      findMany: async ({ where }: { where?: Where }) => query(db.executions, { where }).slice().reverse(),
      findUnique: async ({ where }: { where: { id: string } }) => db.executions.find((row) => row['id'] === where.id) ?? null,
    },
    adminAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const connect = (data['adminUser'] as { connect?: { id?: string } } | undefined)?.connect;
        const row: AuditRow = {
          action: String(data['action']),
          adminUserId: connect?.id ?? null,
          ipAddress: (data['ipAddress'] as string | null | undefined) ?? null,
          userAgent: (data['userAgent'] as string | null | undefined) ?? null,
          metadata: (data['metadata'] as Record<string, unknown>) ?? {},
          createdAt: new Date(),
        };
        db.audit.push(row);
        return row;
      },
      // The lockout check reads these four tables with its own `where`, and the
      // doubles apply exactly that — no filter of their own — so a filter taken
      // out of the service is a filter taken out of the answer.
      findMany: async (args: FindManyArgs) => {
        failIfDown();
        return query(db.audit as unknown as Array<Record<string, unknown>>, args);
      },
    },
    adminUser: {
      findMany: async (args: FindManyArgs) => {
        failIfDown();
        return query(db.admins, args);
      },
    },
    adminLoginAttempt: {
      findMany: async (args: FindManyArgs) => {
        failIfDown();
        return query(db.loginAttempts, args);
      },
    },
    adminIpAllowlist: {
      findMany: async (args: FindManyArgs) => {
        failIfDown();
        return query(db.allowlist, args);
      },
    },
    blockedIp: {
      upsert: async ({ where, create, update }: { where: { address: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const existing = db.blockedIps.get(where.address);
        const row = existing === undefined ? { ...create } : { ...existing, ...update };
        db.blockedIps.set(where.address, row);
        return row;
      },
    },
    user: {
      findUnique: async () => null,
    },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(prisma),
  };

  const probes: AutomationNetworkProbes = {
    localAddresses: () => network.localAddresses,
    serviceHosts: () => network.serviceHosts,
    lookupAll: (hostname, _options, callback) => {
      const addresses = network.dns.get(hostname);
      if (addresses === undefined) {
        callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), []);
        return;
      }
      callback(
        null,
        addresses.map((address): LookupAddress => ({ address, family: address.includes(':') ? 6 : 4 })),
      );
    },
  };

  const httpService = {
    post: (url: string, _body: unknown, config: Record<string, unknown>) => {
      posts.push({ url, config });
      return of({ status: 200, data: {} });
    },
  };

  // RBAC over a role table the admins above describe. Each admin gets a custom
  // role of their own, so the real `resolvePermissions` reads their grants.
  const rbacPrisma = {
    adminRole: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const admin = [...byId.values()].find((candidate) => `role-${candidate.id}` === where.id);
        if (admin === undefined) return null;
        return {
          name: `custom-${admin.id}`,
          isSystem: false,
          permissions: admin.permissions.map((token) => {
            const [resource, action] = token.split(':');
            return { resource, action };
          }),
        };
      },
    },
    // The system-role seed is not this harness's business; it fails soft.
    $transaction: async () => {
      throw new Error('no seed in the automation harness');
    },
  };
  const rbacService = new RbacService(rbacPrisma as never);

  const blockIpSafety = new BlockIpSafetyService(prisma as never, probes);
  const registry = new AutomationActionRegistry(
    httpService as never,
    prisma as never,
    {
      warn: (type: string, category: string, message: string, metadata?: Record<string, unknown>) => {
        emitted.push({ type, category, severity: 'WARNING', message, metadata });
      },
      emit: (event: Record<string, unknown>) => {
        emitted.push(event);
      },
      describeTelegramDelivery: async () => ({ deliverable: true, reason: null }),
    } as never,
    {
      block: async (input: Record<string, unknown>) => {
        userBlocks.push(input);
        return { identitiesCaptured: 0, devicesCaptured: 0, subscriptionsQueued: 0 };
      },
    } as never,
    { raiseWithOutcome: async () => ({ kind: 'queued', delivery: { id: 'delivery-1' } }) } as never,
    {} as never,
    {} as never,
    blockIpSafety,
    probes,
  );
  const executor = new AutomationExecutorService(prisma as never, registry);
  const service = new AutomationsService(prisma as never, executor, blockIpSafety);
  const access = new AutomationRuleAccessService(rbacService);

  const moduleRef = await Test.createTestingModule({
    controllers: [AutomationsController],
    providers: [
      { provide: AutomationsService, useValue: service },
      { provide: EventCatalogService, useValue: { listEvents: async () => [] } },
      { provide: AutomationRuleAccessService, useValue: access },
      { provide: RbacService, useValue: rbacService },
    ],
  })
    .overrideGuard(AdminJwtAuthGuard)
    .useValue({
      canActivate: (context: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }): boolean => {
        const req = context.switchToHttp().getRequest();
        const headers = req['headers'] as Record<string, string | undefined>;
        const admin = byId.get(headers['x-test-admin'] ?? '');
        if (admin === undefined) return false;
        req['user'] = {
          id: admin.id,
          login: admin.id,
          email: null,
          name: null,
          role: admin.role,
          isActive: true,
          tokenVersion: 0,
          createdAt: new Date(),
          lastLoginAt: null,
          lastLoginIp: null,
          rbacRoleId: admin.role === 'DEV' ? null : `role-${admin.id}`,
          mustChangePassword: false,
        };
        return true;
      },
    })
    .compile();

  const app = moduleRef.createNestApplication();
  (app.getHttpAdapter().getInstance() as Express).set('trust proxy', true);
  app.setGlobalPrefix('/api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new AdminSafeExceptionFilter());
  await app.init();

  const server = app.getHttpServer();
  const as = (adminId: string, ip: string = DEFAULT_REQUEST_IP): AdminRequest => {
    const prepare = (test: request.Test): request.Test =>
      test.set('x-test-admin', adminId).set('X-Forwarded-For', ip);
    return {
      get: (path) => prepare(request(server).get(`/api/admin/automations${path}`)),
      post: (path, body = {}) => prepare(request(server).post(`/api/admin/automations${path}`)).send(body),
      put: (path, body = {}) => prepare(request(server).put(`/api/admin/automations${path}`)).send(body),
      patch: (path, body = {}) => prepare(request(server).patch(`/api/admin/automations${path}`)).send(body),
      delete: (path) => prepare(request(server).delete(`/api/admin/automations${path}`)),
    };
  };

  const seedRule = (rule: Partial<RuleRow> & { readonly actions: unknown }): RuleRow => {
    ruleCounter += 1;
    const now = new Date();
    const row: RuleRow = {
      id: rule.id ?? `seeded-${ruleCounter}`,
      name: rule.name ?? `Seeded rule ${ruleCounter}`,
      description: null,
      isEnabled: rule.isEnabled ?? false,
      triggerKind: rule.triggerKind ?? AutomationTriggerKind.MANUAL,
      triggerSpec: rule.triggerSpec ?? '',
      conditions: rule.conditions ?? null,
      actions: rule.actions,
      createdById: null,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunMessage: null,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    db.rules.set(row.id, row);
    return row;
  };

  return { app, db, network, posts, emitted, userBlocks, as, seedRule, executor, prisma, close: () => app.close() };
}

/** A rule body the save route accepts, with the parts a test changes. */
export function ruleBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'A rule',
    isEnabled: false,
    triggerKind: 'MANUAL',
    triggerSpec: '',
    actions: [{ type: 'notify_telegram', params: { text: 'hello' } }],
    ...over,
  };
}

/** The sentences a refusal carried, however the filter shaped them. */
export function messagesOf(body: unknown): string[] {
  const message = (body as { message?: unknown } | null)?.message;
  if (Array.isArray(message)) return message.filter((item): item is string => typeof item === 'string');
  return typeof message === 'string' ? [message] : [];
}

// ── The part of Prisma the doubles speak ─────────────────────────────────────
//
// Strict, like the anti-fraud store: an operator it does not model throws
// rather than matching everything, so a query shape the double does not
// understand cannot turn into a green test.

type Where = Record<string, unknown>;

interface FindManyArgs {
  readonly where?: Where;
  readonly select?: Record<string, boolean>;
  readonly distinct?: readonly string[];
  readonly take?: number;
  readonly orderBy?: unknown;
}

function matchesWhere(row: Record<string, unknown>, where: Where | undefined): boolean {
  if (where === undefined) return true;
  for (const [field, condition] of Object.entries(where)) {
    const value = row[field];
    if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false;
      continue;
    }
    if (typeof condition !== 'object' || condition === null) {
      if (value !== condition) return false;
      continue;
    }
    for (const [operator, operand] of Object.entries(condition as Record<string, unknown>)) {
      switch (operator) {
        case 'not':
          if (operand === null ? value === null || value === undefined : value === operand) return false;
          break;
        case 'gte':
          if (!(value instanceof Date) || !(operand instanceof Date) || value.getTime() < operand.getTime()) return false;
          break;
        default:
          throw new Error(`automation harness: the double does not model '${operator}' (on ${field})`);
      }
    }
  }
  return true;
}

function query<T extends object>(rows: readonly T[], args: FindManyArgs): Array<Record<string, unknown>> {
  let out = rows.filter((row) => matchesWhere(row as Record<string, unknown>, args.where)) as Array<Record<string, unknown>>;
  const distinct = args.distinct;
  if (distinct !== undefined) {
    const seen = new Set<string>();
    out = out.filter((row) => {
      const key = JSON.stringify(distinct.map((field) => row[field]));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (typeof args.take === 'number') out = out.slice(0, args.take);
  const select = args.select;
  if (select !== undefined) {
    out = out.map((row) =>
      Object.fromEntries(Object.keys(select).filter((field) => select[field]).map((field) => [field, row[field]])),
    );
  }
  return out;
}

/** A later instant than `previous`, however fast the test runs: Postgres `updatedAt` always moves. */
function nextTimestamp(previous: Date): Date {
  const now = Date.now();
  return new Date(now > previous.getTime() ? now : previous.getTime() + 1);
}

function jsonColumn(value: unknown): unknown {
  if (value === Prisma.DbNull || value === Prisma.JsonNull || value === undefined) return null;
  return value;
}

function cloneRule(row: RuleRow | undefined): RuleRow | null {
  return row === undefined ? null : { ...row };
}
