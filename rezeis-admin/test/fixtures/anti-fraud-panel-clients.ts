import {
  PanelDevicesClient,
  type PanelDevicesOutcome,
  type PanelHwidDeviceStats,
  type PanelHwidTopUsersPage,
  type PanelNodeConnectionUser,
  type PanelUserConnectionNode,
} from '../../src/modules/remnawave/services/panel-devices.client';
import {
  PanelInfraClient,
  type PanelNode,
  type PanelNodeUsersBandwidth,
  type PanelReadOutcome,
  type PanelSubscriptionRequestHistoryPage,
} from '../../src/modules/remnawave/services/panel-infra.client';

/**
 * Panel-client doubles for the anti-fraud detector specs.
 *
 * ── WHY THE OUTCOME TYPES ARE SPELLED OUT AND NOT CAST AWAY ────────────────
 * The whole point of the migration these back is that a panel read has THREE
 * answers, not two: the data, "we looked and there was nobody", and "we could
 * not look". A double that only ever hands back rows can prove the first two
 * and is silent about the third — which is the exact failure this module keeps
 * rediscovering, since "could not look" rendered as "clean" is how a detector
 * reports a healthy panel forever. So every builder here takes a real
 * `PanelDevicesOutcome` / `PanelReadOutcome`, and the failure arms below exist
 * so a spec can say which failure it means.
 *
 * The doubles record their calls for the same reason the specs they replace
 * did: a detector that stands down must be shown NOT to have touched the panel,
 * and a detector that scans must be shown to have scanned the nodes it claims.
 */

// ── Outcome constructors ─────────────────────────────────────────────────────

export function panelOk<T>(data: T, drifted = false): PanelReadOutcome<T> {
  return { kind: 'ok', data, drifted };
}

/** The panel answered, and refused. */
export function panelRejected(status = 404, code: string | null = null): PanelReadOutcome<never> {
  return { kind: 'rejected', status, code, detail: null, retryAfterMs: null };
}

/** Nothing came back — DNS, reset, timeout. */
export function panelNetworkFailure(detail = 'socket hang up'): PanelReadOutcome<never> {
  return { kind: 'network', detail };
}

/** The panel answered 2xx with a body the asked-for data is not findable in. */
export function panelUnreadable(detail = 'the payload carries no `response`'): PanelReadOutcome<never> {
  return { kind: 'unreadable', detail };
}

/** Our own bad request, refused by the contract before anything was sent. */
export function panelInvalidRequest(
  detail = 'nodesUuids: Array must contain at least 1 element(s)',
): PanelReadOutcome<never> {
  return { kind: 'invalid-request', detail, command: 'POST /api/example' };
}

// ── Row builders ─────────────────────────────────────────────────────────────

const NODE_DEFAULTS = {
  address: '10.0.0.1',
  port: 443,
  proxyUrl: null,
  isConnected: true,
  isDisabled: false,
  isConnecting: false,
  lastStatusMessage: null,
  isTrafficTrackingActive: false,
  trafficResetDay: null,
  trafficLimitBytes: null,
  trafficUsedBytes: null,
  notifyPercent: null,
  viewPosition: 1,
  countryCode: 'DE',
  consumptionMultiplier: 1,
  nodeConsumptionMultiplier: 1,
  tags: [],
  integrationUuids: [],
  ips: [],
  configProfile: { activeConfigProfileUuid: null, activeInbounds: [] },
  providerUuid: null,
  provider: null,
  activePluginUuid: null,
  system: null,
  versions: null,
  xrayUptime: 0,
  usersOnline: 0,
  note: null,
};

/**
 * One node, with everything the contract declares filled in.
 *
 * A spec names the four or five fields it is actually about; the rest are
 * present because `PanelNode` is `z.infer` of the vendor's own schema and a
 * partial cast would let a detector read a field this fixture never modelled.
 */
export function panelNode(
  over: Partial<PanelNode> & { readonly uuid: string; readonly name?: string },
): PanelNode {
  return {
    ...NODE_DEFAULTS,
    id: 1,
    name: over.name ?? over.uuid,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastStatusChange: null,
    ...over,
  } as unknown as PanelNode;
}

/** One walk of `/api/hwid/devices/top-users`, as the client reports it. */
export function hwidTopUsersPage(
  users: ReadonlyArray<{ id: number; username: string; devicesCount: number }>,
  over: { total?: number; complete?: boolean } = {},
): PanelHwidTopUsersPage {
  return {
    users: [...users],
    total: over.total ?? users.length,
    complete: over.complete ?? true,
  };
}

// ── Clients ──────────────────────────────────────────────────────────────────

export interface PanelDevicesDoubleInput {
  readonly topUsers?: PanelDevicesOutcome<PanelHwidTopUsersPage>;
  readonly deviceStats?: PanelDevicesOutcome<PanelHwidDeviceStats>;
  /**
   * Per node uuid. A uuid ABSENT from this record answers `null` — "this node
   * could not be read" — which is deliberately not the same as mapping it to
   * `[]`. A spec that means "this node was read and was quiet" has to say so.
   */
  readonly nodeConnections?: Readonly<Record<string, readonly PanelNodeConnectionUser[] | null>>;
  readonly userConnections?: readonly PanelUserConnectionNode[] | null;
  readonly dropOutcome?: PanelDevicesOutcome<unknown>;
}

export interface PanelClientDouble<TClient> {
  readonly client: TClient;
  /** Every call the detector made, in order, as `method` or `method:argument`. */
  readonly calls: string[];
}

export function panelDevicesDouble(
  input: PanelDevicesDoubleInput = {},
): PanelClientDouble<PanelDevicesClient> & { readonly dropBodies: unknown[] } {
  const calls: string[] = [];
  const dropBodies: unknown[] = [];
  const client = {
    listTopUsersByDeviceCount: () => {
      calls.push('listTopUsersByDeviceCount');
      return Promise.resolve(input.topUsers ?? panelOk(hwidTopUsersPage([])));
    },
    getDeviceStats: () => {
      calls.push('getDeviceStats');
      return Promise.resolve(input.deviceStats ?? panelRejected());
    },
    fetchNodeConnections: (nodeUuid: string) => {
      calls.push(`fetchNodeConnections:${nodeUuid}`);
      const rows = input.nodeConnections?.[nodeUuid];
      return Promise.resolve(rows === undefined ? null : rows);
    },
    fetchUserConnections: (userId: number) => {
      calls.push(`fetchUserConnections:${userId}`);
      return Promise.resolve(input.userConnections ?? null);
    },
    dropConnections: (body: unknown) => {
      calls.push('dropConnections');
      dropBodies.push(body);
      return Promise.resolve(input.dropOutcome ?? panelOk<unknown>(undefined));
    },
  } as unknown as PanelDevicesClient;
  return { client, calls, dropBodies };
}

export interface PanelInfraDoubleInput {
  readonly nodes?: PanelReadOutcome<readonly PanelNode[]>;
  readonly nodeUsersBandwidth?: PanelReadOutcome<PanelNodeUsersBandwidth>;
  readonly requestHistory?: PanelReadOutcome<PanelSubscriptionRequestHistoryPage>;
}

export function panelInfraDouble(
  input: PanelInfraDoubleInput = {},
): PanelClientDouble<PanelInfraClient> & {
  readonly bandwidthRequests: Array<{
    nodeUuids: readonly string[];
    start: string;
    end: string;
    topUsersLimit: number;
  }>;
  readonly historyRequests: Array<{ start?: number; size?: number }>;
} {
  const calls: string[] = [];
  const bandwidthRequests: Array<{
    nodeUuids: readonly string[];
    start: string;
    end: string;
    topUsersLimit: number;
  }> = [];
  const historyRequests: Array<{ start?: number; size?: number }> = [];
  const client = {
    getNodes: () => {
      calls.push('getNodes');
      return Promise.resolve(input.nodes ?? panelOk<readonly PanelNode[]>([]));
    },
    getNodeUsersBandwidth: (request: {
      nodeUuids: readonly string[];
      start: string;
      end: string;
      topUsersLimit: number;
    }) => {
      calls.push('getNodeUsersBandwidth');
      bandwidthRequests.push(request);
      return Promise.resolve(
        input.nodeUsersBandwidth ??
          panelOk<PanelNodeUsersBandwidth>({
            categories: [],
            sparklineData: [],
            topUsers: [],
          } as unknown as PanelNodeUsersBandwidth),
      );
    },
    getSubscriptionRequestHistory: (request: { start?: number; size?: number } = {}) => {
      calls.push('getSubscriptionRequestHistory');
      historyRequests.push(request);
      return Promise.resolve(
        input.requestHistory ??
          panelOk<PanelSubscriptionRequestHistoryPage>({
            records: [],
            total: 0,
          } as unknown as PanelSubscriptionRequestHistoryPage),
      );
    },
  } as unknown as PanelInfraClient;
  return { client, calls, bandwidthRequests, historyRequests };
}

/** Per-user traffic rows, as `POST /api/bandwidth-stats/nodes/users` returns them. */
export function nodeUsersBandwidth(
  topUsers: ReadonlyArray<{ username: string; total: number }>,
): PanelNodeUsersBandwidth {
  return {
    categories: [],
    sparklineData: [],
    topUsers: topUsers.map((row) => ({ color: '#000000', ...row })),
  } as unknown as PanelNodeUsersBandwidth;
}
