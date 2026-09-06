import { Injectable, Logger } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';

// Relative, not the `@/` alias: the panel's specs run under
// `ts-node/register/transpile-only`, which does not resolve path aliases, and
// the alias would make this service unloadable from a test.
import { RawCacheService } from '../../../common/cache';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RemnawaveHostInterface } from '../interfaces/remnawave-host.interface';
import { RemnawaveNodeInterface } from '../interfaces/remnawave-node.interface';
import { RemnawaveInternalSquadDetailInterface } from '../interfaces/remnawave-squad-detail.interface';
import {
  SubscriberServerInterface,
  SubscriberServersInterface,
} from '../interfaces/subscriber-server.interface';
import { resolveHostCountry } from '../utils/host-flag.util';
import { RemnawaveApiService } from './remnawave-api.service';

/**
 * The servers one subscriber may see, and which of them to use right now.
 *
 * THE CHAIN. A subscription carries `internalSquads` — squad UUIDs, assigned by
 * its plan and stored in our own database, which is also what gets pushed to
 * Remnawave. A squad carries inbounds. A host names one inbound in
 * `configProfileInboundUuid`. So: subscription → squads → inbound UUIDs →
 * hosts. Every link already existed; only the middle one was being thrown away,
 * because `mapInternalSquadDetails` kept the inbound COUNT and dropped the
 * inbounds themselves. It now keeps their UUIDs — and nothing else from them,
 * for the reason spelled out in that mapper.
 *
 * INTERNAL SQUADS ONLY. A user also carries a single `externalSquadUuid`, and
 * external squads are deliberately absent here: Remnawave's external-squad
 * payload has no `inbounds` array at all, so there is no way to learn which
 * hosts one contains. Listing external squads would mean either inventing that
 * membership or showing a customer an empty section they cannot act on.
 *
 * ONE SNAPSHOT FOR EVERYONE. Hosts, nodes and squads are panel-wide: two
 * subscribers opening this screen at the same moment need the same three calls
 * to Remnawave. They are fetched once and cached for {@link SNAPSHOT_TTL_SECONDS}
 * seconds, after which the filtering is pure local work. The TTL is short
 * because node state is what the screen is for — but it is not zero, because
 * this opens on a double tap, and a double tap is cheap to repeat.
 */
@Injectable()
export class SubscriberServersService {
  private readonly logger = new Logger(SubscriberServersService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly cacheService: RawCacheService,
  ) {}

  /**
   * The servers behind one subscription of one user.
   *
   * Returns an empty list rather than throwing when the subscription has no
   * squads, when Remnawave is unreachable, or when nothing matches: this
   * screen is decoration over a working subscription, and it must never be the
   * reason a customer sees an error.
   */
  public async getForSubscription(
    userId: string,
    subscriptionId: string,
  ): Promise<SubscriberServersInterface> {
    const subscription = await this.prismaService.subscription.findFirst({
      // `status` matters as much as the ownership: deletion does not clear
      // `internalSquads`, so a deleted subscription whose id the customer
      // still has from an earlier session kept answering with a full list
      // headed "available servers". Every other read of this table in the
      // codebase excludes DELETED for the same reason.
      where: { id: subscriptionId, userId, status: { not: SubscriptionStatus.DELETED } },
      select: { internalSquads: true },
    });

    if (!subscription || subscription.internalSquads.length === 0) {
      return { servers: [], recommendedServerId: null };
    }

    const snapshot = await this.readSnapshot();
    if (!snapshot) return { servers: [], recommendedServerId: null };

    const servers = buildServers(subscription.internalSquads, snapshot);
    return { servers, recommendedServerId: pickRecommended(servers) };
  }

  /**
   * Hosts, nodes and internal squads as one cached triple.
   *
   * All three or none: a partial snapshot would silently drop either the
   * squad→host link or every server's state, and both failures look to the
   * reader like "you have no servers" rather than like a panel that is down.
   */
  private async readSnapshot(): Promise<PanelSnapshot | null> {
    const cached = await this.cacheService.get<PanelSnapshot>(SNAPSHOT_CACHE_KEY);
    if (cached) return cached;

    try {
      const [hosts, nodes, squads] = await Promise.all([
        this.remnawaveApiService.getAllHosts(),
        this.remnawaveApiService.getAllNodes(),
        this.remnawaveApiService.getInternalSquadDetails(),
      ]);
      const snapshot: PanelSnapshot = { hosts, nodes, squads };
      // NOT cached when a leg came back empty, and the docblock above says
      // "all three or none" because of this. `getAllHosts` and `getAllNodes`
      // swallow their own failures and answer `[]`, so `Promise.all` resolves
      // happily with a snapshot that is missing half of what it needs — no
      // hosts reads as "you have no servers", no nodes turns every server
      // `unknown` with no recommendation — and caching it pinned that state
      // for twenty seconds for every subscriber at once. An install that
      // genuinely has no hosts simply re-reads; it is showing nothing either
      // way, and the read is three cheap calls.
      if (hosts.length > 0 && nodes.length > 0) {
        await this.cacheService.set(SNAPSHOT_CACHE_KEY, snapshot, SNAPSHOT_TTL_SECONDS);
      }
      return snapshot;
    } catch (error) {
      this.logger.warn(
        `Could not read the panel snapshot for the subscriber server list: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}

const SNAPSHOT_CACHE_KEY = 'remnawave:subscriber-servers:snapshot';
/**
 * Short enough that a node going down shows up while the customer is still
 * looking; long enough that a burst of double taps is three calls, not three
 * hundred.
 */
const SNAPSHOT_TTL_SECONDS = 20;

interface PanelSnapshot {
  readonly hosts: readonly RemnawaveHostInterface[];
  readonly nodes: readonly RemnawaveNodeInterface[];
  readonly squads: readonly RemnawaveInternalSquadDetailInterface[];
}

/**
 * Filters the snapshot down to what these squads reach, and describes each one.
 *
 * Exported for the spec: the interesting behaviour is all in here, and testing
 * it through the service would mean standing up Prisma and Redis to assert
 * something that is a pure function of three arrays.
 */
export function buildServers(
  squadUuids: readonly string[],
  snapshot: PanelSnapshot,
): readonly SubscriberServerInterface[] {
  const wanted = new Set(squadUuids);
  const reachableInbounds = new Set<string>();
  for (const squad of snapshot.squads) {
    if (!wanted.has(squad.uuid)) continue;
    for (const inbound of squad.inboundUuids) reachableInbounds.add(inbound);
  }
  if (reachableInbounds.size === 0) return [];

  const nodesByUuid = new Map(snapshot.nodes.map((node) => [node.uuid, node]));

  return snapshot.hosts
    .filter((host) => {
      // A hidden or disabled host is not in the customer's config, so it is not
      // one of their servers — the list says "available", and showing an
      // unreachable entry as merely "offline" would be a different claim.
      if (host.isHidden || host.isDisabled) return false;
      return (
        host.configProfileInboundUuid !== null &&
        reachableInbounds.has(host.configProfileInboundUuid)
      );
    })
    .sort((a, b) => a.viewPosition - b.viewPosition)
    .map((host) => describeHost(host, nodesByUuid));
}

function describeHost(
  host: RemnawaveHostInterface,
  nodesByUuid: ReadonlyMap<string, RemnawaveNodeInterface>,
): SubscriberServerInterface {
  const nodes = host.nodes
    .map((uuid) => nodesByUuid.get(uuid))
    .filter((node): node is RemnawaveNodeInterface => node !== undefined);

  const { flag, countryCode } = resolveHostCountry(
    host.remark,
    nodes.map((node) => node.countryCode),
  );

  const live = nodes.filter((node) => !node.isDisabled);
  const connected = live.filter((node) => node.isConnected);

  return {
    id: host.uuid,
    name: host.remark,
    flag,
    countryCode,
    status: resolveStatus(live, connected),
    // Only a connected node's uptime means anything; a disconnected node keeps
    // reporting whatever it last managed. Where a host spans several, the
    // longest-running one is the honest answer to "how long has this been up".
    uptimeSeconds:
      connected.length > 0
        ? Math.max(...connected.map((node) => node.xrayUptime))
        : null,
    usersOnline:
      connected.length > 0
        ? connected.reduce((total, node) => total + node.usersOnline, 0)
        : null,
  };
}

function resolveStatus(
  live: readonly RemnawaveNodeInterface[],
  connected: readonly RemnawaveNodeInterface[],
): SubscriberServerInterface['status'] {
  if (connected.length > 0) return 'online';
  if (live.some((node) => node.isConnecting)) return 'connecting';
  // No node at all is not the same as every node being down, and reporting it
  // as `offline` would tell the customer their server is broken when what is
  // actually true is that the panel never linked one.
  if (live.length === 0) return 'unknown';
  return 'offline';
}

/**
 * The least busy server that is actually up.
 *
 * Ties break on the operator's own ordering rather than on host UUID, so the
 * recommendation stays stable between two calls that see identical load — a
 * badge that moves between servers on every refresh reads as a malfunction.
 *
 * Exported for the same reason as `buildServers`: this is the rule, and a spec
 * that reimplements it in order to check it has verified nothing.
 */
export function pickRecommended(
  servers: readonly SubscriberServerInterface[],
): string | null {
  let best: SubscriberServerInterface | null = null;
  for (const server of servers) {
    if (server.status !== 'online') continue;
    if (best === null || (server.usersOnline ?? 0) < (best.usersOnline ?? 0)) {
      best = server;
    }
  }
  return best?.id ?? null;
}
