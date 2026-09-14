import { z } from 'zod';

import type { PanelCommand } from './panel-command.contract';

/**
 * Every panel command rezeis issues through `PanelCommandExecutor`, hand-owned
 * ═════════════════════════════════════════════════════════════════════════════
 * Twenty-one entries — exactly the commands production reaches, and nothing a
 * caller does not send. Keyed by the vendor's own command name so a reader can
 * grep one against the other and `test/panel-command-conformance.spec.ts` can
 * walk them side by side.
 *
 * WHAT EACH ENTRY OWNS: the path (a builder where the route carries a segment),
 * the verb, a description, and the request schemas the vendor's contract
 * enforced for the inputs WE send — the same checks, the same custom messages,
 * the same defaults, and the same key ORDER, because the executor sends the
 * parsed body and zod emits keys in schema order. Reordering a body schema below
 * reorders the bytes on the wire; `test/panel-wire-bytes.spec.ts` will say so.
 *
 * WHAT THEY DO NOT OWN: responses. No response schema is executed at runtime —
 * see `panel-command.contract.ts` for why that stopped being a benefit.
 *
 * WHY THIS IS SAFE TO OWN, and what keeps it honest. The request side of these
 * twenty-one commands (url, verb, param/query/body schemas) is identical in
 * every contract the fleet's panels ship — 3.2.0 (panel 3.2.0–3.2.1), 3.2.3,
 * 3.4.2 (panel 3.3.x), 3.4.13 (panel 3.4.0–3.4.3) and 3.4.15 (panel 3.4.4) —
 * with two measured exceptions, neither of which reaches the wire:
 *
 *   • `CreateUserCommand.vlessUuid` changed its guid pattern after 3.2.0. rezeis
 *     never sends `vlessUuid`, so the field is not declared here at all;
 *   • contracts from 3.4.12 on run zod 4.5, which requires seconds in a datetime
 *     that carries `Z` or an offset. Production sends `toISOString()`, which
 *     always has them; this copy runs the same zod minor as the newest eras.
 *
 * The conformance spec checks every entry against every one of those contracts
 * — the URL a builder produces, the verb, and the accept/refuse verdict on a
 * corpus of accepted and refused inputs — so a route, verb or rule that moves in
 * any era fails CI instead of a live panel.
 *
 * ADDING A COMMAND: add it here, add its vendor name to the conformance spec's
 * list, and give it corpus cases. Declare only the fields a caller sends: a key
 * the schema does not declare is dropped before the request, with a warning.
 */

// ── Shared pieces ───────────────────────────────────────────────────────────

/** `z.coerce.number().positive()` — the vendor's `numberParamSchema`. */
const numericUserIdParams = z.object({ userId: z.coerce.number().positive() });

/** Both result routes take the job id as an opaque string. */
const jobIdParams = z.object({ jobId: z.string() });

const USER_STATUSES = ['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED'] as const;
const RESET_PERIODS = ['NO_RESET', 'DAY', 'WEEK', 'MONTH', 'MONTH_ROLLING'] as const;

/** A panel datetime, turned into a `Date` exactly as the vendor schema did. */
function panelDatetime() {
  return z.iso.datetime({ offset: true, local: true }).transform((value) => new Date(value));
}

function panelTag() {
  return z
    .string()
    .regex(/^[A-Z0-9_]+$/, 'Tag can only contain uppercase letters, numbers, underscores')
    .max(16, 'Tag must be less than 16 characters')
    .nullable();
}

/** `start` / `size` paging, capped where the panel caps it. */
function pagingQuery(maxSize: number, defaultSize: number) {
  return z.object({
    start: z.coerce.number().default(0),
    size: z.coerce
      .number()
      .min(1, 'Size (limit) must be greater than 0')
      .max(maxSize, `Size (limit) must be less than ${maxSize}`)
      .default(defaultSize),
  });
}

// ── The table ───────────────────────────────────────────────────────────────

export const PANEL_COMMANDS = {
  // ── Users ────────────────────────────────────────────────────────────────

  CreateUserCommand: {
    url: '/api/users/',
    method: 'post',
    description: 'Create a new user',
    // Key order is the vendor's. `status` and `trafficLimitStrategy` carry the
    // vendor's defaults, so a create that omits them still sends ACTIVE and
    // NO_RESET — which is what has always reached the panel.
    body: z.object({
      username: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscores and dashes')
        .max(36, 'Username must be less than 36 characters')
        .min(3, 'Username must be at least 3 characters'),
      status: z.enum(USER_STATUSES).default('ACTIVE').optional(),
      trafficLimitBytes: z.number().min(0, 'Traffic limit must be greater than 0').optional(),
      trafficLimitStrategy: z.optional(z.enum(RESET_PERIODS).default('NO_RESET')),
      expireAt: panelDatetime(),
      description: z.string().optional(),
      tag: z.optional(panelTag()),
      telegramId: z.number().nullish(),
      email: z.email().nullish(),
      hwidDeviceLimit: z.optional(z.int().min(0)),
      activeInternalSquads: z.array(z.uuid()).optional(),
      externalSquadUuid: z.optional(z.nullable(z.uuid())),
    }),
  },

  UpdateUserCommand: {
    url: '/api/users/',
    method: 'patch',
    description: 'Update a user',
    body: z
      .object({
        username: z.optional(z.string()),
        id: z.optional(z.number()),
        status: z.enum(['ACTIVE', 'DISABLED']).optional(),
        trafficLimitBytes: z.number().min(0).optional(),
        trafficLimitStrategy: z.enum(RESET_PERIODS).optional(),
        expireAt: panelDatetime()
          .refine((date) => date > new Date(), { error: 'Expiration date cannot be in the past' })
          .optional(),
        description: z.optional(z.string().nullable()),
        tag: z.optional(panelTag()),
        telegramId: z.number().nullish(),
        email: z.email().nullish(),
        hwidDeviceLimit: z.int().min(0).nullish(),
        activeInternalSquads: z.array(z.uuid()).optional(),
        externalSquadUuid: z.optional(z.nullable(z.uuid())),
      })
      // TRUTHINESS, as the vendor wrote it: `id: 0` and `username: ''` do not
      // name a user, and a body carrying only those is refused.
      .refine((body) => body.username ?? body.id, {
        error: 'At least one of username, id must be provided',
      }),
  },

  GetUserByIdCommand: {
    url: (userId: string): string => `/api/users/${userId}`,
    method: 'get',
    description: 'Get user by ID',
    params: numericUserIdParams,
  },

  DeleteUserCommand: {
    url: (userId: string): string => `/api/users/${userId}`,
    method: 'delete',
    description: 'Delete user',
    params: numericUserIdParams,
  },

  GetUserByUsernameCommand: {
    // The segment arrives ENCODED from the client; the builder interpolates it
    // as given, exactly as the vendor's does.
    url: (username: string): string => `/api/users/by-username/${username}`,
    method: 'get',
    description: 'Get user by username',
    params: z.object({ username: z.string() }),
  },

  ResolveUserCommand: {
    url: '/api/users/resolve',
    method: 'post',
    description: 'Resolve a user',
    body: z
      .object({
        id: z.number().optional(),
        shortUuid: z.string().optional(),
        username: z.string().optional(),
      })
      .refine(
        (body) => [body.id, body.shortUuid, body.username].filter((v) => v !== undefined).length === 1,
        { error: 'Exactly one of id, shortUuid, or username must be provided' },
      ),
  },

  ResetUserTrafficCommand: {
    url: (userId: string): string => `/api/users/${userId}/actions/reset-traffic`,
    method: 'post',
    description: 'Reset user traffic',
    params: numericUserIdParams,
  },

  // ── HWID devices ─────────────────────────────────────────────────────────

  GetHwidDevicesCommand: {
    url: '/api/hwid/devices',
    method: 'get',
    description: 'Get HWID devices',
    // Paging only. The vendor also accepts `filters`, `filterModes`,
    // `globalFilterMode` and `sorting`, which rezeis never sends.
    query: pagingQuery(1000, 25),
  },

  GetTopUsersByHwidDevicesCommand: {
    url: '/api/hwid/devices/top-users',
    method: 'get',
    description: 'Get top users by HWID devices',
    query: pagingQuery(100, 5),
  },

  GetHwidDevicesStatsCommand: {
    url: '/api/hwid/devices/stats',
    method: 'get',
    description: 'Get HWID devices stats',
  },

  // ── Live connections ─────────────────────────────────────────────────────
  // Start and result are the SAME path with different verbs, and the segment
  // means different things: the user id (or node uuid) on the POST, the JOB id
  // on the GET. The params schemas are what keeps the two apart.

  ConnectionsByUserCommand: {
    url: (userId: string): string => `/api/connections/by-user/${userId}`,
    method: 'post',
    description: 'Request Connections for User',
    params: numericUserIdParams,
  },

  ConnectionsByUserResultCommand: {
    url: (jobId: string): string => `/api/connections/by-user/${jobId}`,
    method: 'get',
    description: 'Get Connections for User by Job ID',
    params: jobIdParams,
  },

  ConnectionsByNodeCommand: {
    url: (nodeUuid: string): string => `/api/connections/by-node/${nodeUuid}`,
    method: 'post',
    description: 'Request Connections for Node',
    params: z.object({ nodeUuid: z.uuid() }),
  },

  ConnectionsByNodeResultCommand: {
    url: (jobId: string): string => `/api/connections/by-node/${jobId}`,
    method: 'get',
    description: 'Get Connections for Node by Job ID',
    params: jobIdParams,
  },

  DropConnectionsCommand: {
    url: '/api/connections/drop',
    method: 'post',
    description: 'Drop Connections for Users or IPs',
    body: z.object({
      dropBy: z.discriminatedUnion('by', [
        z.object({ by: z.literal('userIds'), userIds: z.array(z.number()).min(1) }),
        z.object({
          by: z.literal('ipAddresses'),
          ipAddresses: z.array(z.union([z.ipv4(), z.ipv6()])).min(1),
        }),
      ]),
      targetNodes: z.discriminatedUnion('target', [
        z.object({ target: z.literal('allNodes') }),
        z.object({ target: z.literal('specificNodes'), nodeUuids: z.array(z.uuid()).min(1) }),
      ]),
    }),
  },

  // ── Infrastructure ───────────────────────────────────────────────────────
  // THE TRAILING SLASHES ARE THE VENDOR'S and are what rezeis has always sent.
  // The panel's router answers both spellings today; do not "tidy" them.

  GetMetadataCommand: {
    url: '/api/system/metadata',
    method: 'get',
    description: 'Get Remnawave Information',
  },

  GetNodesCommand: {
    url: '/api/nodes/',
    method: 'get',
    description: 'Get nodes',
  },

  GetStatsNodesUsersUsageCommand: {
    url: '/api/bandwidth-stats/nodes/users',
    method: 'post',
    description: 'Get Nodes Users Usage by Nodes UUIDs',
    // The window travels in the query and is NOT validated here — it never has
    // been, and the conformance spec checks the one query production sends
    // against each of the five 3.x contract oracles instead. The node list is
    // validated: minimum one.
    body: z.object({ nodesUuids: z.array(z.uuid()).min(1) }),
  },

  GetInternalSquadsCommand: {
    url: '/api/internal-squads/',
    method: 'get',
    description: 'Get all internal squads',
  },

  GetExternalSquadsCommand: {
    url: '/api/external-squads/',
    method: 'get',
    description: 'Get all external squads',
  },

  GetSubscriptionRequestHistoryCommand: {
    url: '/api/subscription-request-history/',
    method: 'get',
    description: 'Get all subscription request history',
  },
} as const satisfies Readonly<Record<string, PanelCommand>>;

export type PanelCommandName = keyof typeof PANEL_COMMANDS;
