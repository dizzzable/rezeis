import { Injectable, Logger } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';

// Relative, not the `@/` alias: the panel's specs run under
// `ts-node/register/transpile-only`, which does not resolve path aliases, and
// the alias would make this service unloadable from a test.
import { RawCacheService } from '../../../common/cache';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  RemnawaveExternalSquadHostOverrideInterface,
  RemnawaveHostInterface,
} from '../interfaces/remnawave-host.interface';
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
 * INTERNAL SQUADS DECIDE THE HOSTS. A user also carries a single
 * `externalSquadUuid`, and it adds no host here: Remnawave's external-squad
 * payload has no `inbounds` array at all, so there is no way to learn which
 * hosts one contains. Listing external squads would mean either inventing that
 * membership or showing a customer an empty section they cannot act on. What
 * an external squad DOES change is a label — its `hostOverrides` replace the
 * badge on every host its members receive — so that one field is read; see
 * `badgeOverride`.
 *
 * ONE SNAPSHOT FOR EVERYONE. Hosts, nodes and squads are panel-wide: two
 * subscribers opening this screen at the same moment need the same four calls
 * to Remnawave. They are fetched once and cached for {@link SNAPSHOT_TTL_SECONDS}
 * seconds, after which the filtering is pure local work. The TTL is short
 * because node state is what the screen is for — but it is not zero, because
 * this opens on a double tap, and a double tap is cheap to repeat. What belongs
 * to one subscriber — the remark rendered for them, their external squad's
 * badge — is applied over the snapshot on every request and never stored in it.
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
      // The squads decide the hosts; the rest is what makes the list this
      // subscriber's — their external squad's badge, and the values a remark
      // is rendered with (see `SubscriberView`).
      select: {
        internalSquads: true,
        externalSquad: true,
        status: true,
        expiresAt: true,
        remnawavePanelUsername: true,
      },
    });

    if (!subscription) {
      // Not this user's, or deleted. A stale page explains it, so it is quiet.
      this.explain(subscriptionId, {
        level: 'debug',
        reason: 'no such subscription for this user (deleted, or not theirs)',
      });
      return { servers: [], recommendedServerId: null };
    }
    if (subscription.internalSquads.length === 0) {
      this.explain(subscriptionId, explainEmpty([], EMPTY_SNAPSHOT));
      return { servers: [], recommendedServerId: null };
    }

    const snapshot = await this.readSnapshot();
    // `readSnapshot` has already warned with the upstream error, which says
    // more than anything this could add.
    if (!snapshot) return { servers: [], recommendedServerId: null };

    const servers = buildServers(subscription.internalSquads, snapshot, {
      externalSquad: subscription.externalSquad,
      status: subscription.status,
      expiresAt: subscription.expiresAt,
      panelUsername: subscription.remnawavePanelUsername,
      now: Date.now(),
    });
    if (servers.length === 0) {
      this.explain(subscriptionId, explainEmpty(subscription.internalSquads, snapshot));
    }
    return { servers, recommendedServerId: pickRecommended(servers) };
  }

  /**
   * Says why the customer is looking at an empty screen.
   *
   * The line that was missing. An empty list has seven distinct causes and
   * exactly one appearance, so an operator reporting "it shows no servers"
   * handed us nothing to work with -- which is how a mapper reading the wrong
   * field survived a release.
   *
   * The level comes from the reason rather than being fixed here, because
   * `SystemLogsService` floors at `log` in production: a broken link has to be
   * `warn` to reach the Logs page at all, and a plan the operator deliberately
   * left without squads has to stay below it, or the channel becomes noise.
   */
  private explain(subscriptionId: string, { level, reason }: EmptyReason): void {
    const line = `Empty server list for subscription ${subscriptionId}: ${reason}`;
    if (level === 'warn') this.logger.warn(line);
    else this.logger.debug(line);
  }

  /**
   * Hosts, nodes, internal squads and external squads' badges, cached as one.
   *
   * The first three all or none: a partial snapshot would silently drop either
   * the squad→host link or every server's state, and both failures look to the
   * reader like "you have no servers" rather than like a panel that is down.
   * The external squads are the exception, because they only relabel badges.
   */
  private async readSnapshot(): Promise<PanelSnapshot | null> {
    const cached = await this.cacheService.get<PanelSnapshot>(SNAPSHOT_CACHE_KEY);
    if (cached) return cached;

    try {
      const [hosts, nodes, squads, externalSquads] = await Promise.all([
        this.remnawaveApiService.getAllHosts(),
        this.remnawaveApiService.getAllNodes(),
        this.remnawaveApiService.getInternalSquadDetails(),
        // The one leg allowed to fail on its own, and it fails into "no squad
        // overrides a badge": a customer in such a squad loses a label, never
        // the list, which goes out with each host's own badge. Nothing is
        // logged here — the transport has already warned with the upstream
        // error, once for this read.
        this.remnawaveApiService
          .getExternalSquadHostOverrides()
          .catch((): readonly RemnawaveExternalSquadHostOverrideInterface[] => []),
      ]);
      const snapshot: PanelSnapshot = { hosts, nodes, squads, externalSquads };
      // NOT cached when a leg came back empty, and the docblock above says
      // "all or none" because of this. `getAllHosts` and `getAllNodes`
      // swallow their own failures and answer `[]`, so `Promise.all` resolves
      // happily with a snapshot that is missing half of what it needs — no
      // hosts reads as "you have no servers", no nodes turns every server
      // `unknown` with no recommendation — and caching it pinned that state
      // for twenty seconds for every subscriber at once. An install that
      // genuinely has no hosts simply re-reads; it is showing nothing either
      // way, and the read is four cheap calls.
      //
      // A failed external-squads read does NOT keep the snapshot out, and it
      // used to. That read can fail for good on a healthy panel — a Remnawave
      // 3.4.4 API token scoped without external squads is refused on every
      // call — and while it decided the caching, every request by every
      // subscriber made all four calls again and wrote one more warning, for
      // a list that looked right. Cached without the overrides, a failure
      // costs one failed call and one warning per TTL, not per request, and a
      // brief one leaves those badges unrelabelled for one TTL at most.
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

/**
 * The snapshot cache key, and the `:v3` on the end is load-bearing.
 *
 * What is stored under it is the POST-mapper snapshot — `RemnawaveHostInterface`
 * objects, serialised with `JSON.stringify` and read back with an unchecked
 * `JSON.parse(...) as T`. That makes this key a wire format between panel
 * VERSIONS, not just a cache: the Redis container is not recreated when the
 * panel image is replaced, so for the rest of the TTL a freshly upgraded panel
 * reads rows written by the previous one.
 *
 * 3.4 support replaced `excludedInternalSquads` with `internalSquads` (`:v2`),
 * and the external squads' badges joined the snapshot (`:v3`), so snapshots
 * from before either change are a different shape, and the versions must not
 * meet. Bumping the suffix separates them: each version reads only what it
 * wrote, both while an upgrade settles and in a blue/green deployment where
 * both are live against one Redis at once. Rolling back is symmetric.
 *
 * **Change the shape of `PanelSnapshot`, bump this suffix.** Nothing enforces
 * it — a stale row deserialises silently, which is the whole problem.
 */
const SNAPSHOT_CACHE_KEY = 'remnawave:subscriber-servers:snapshot:v3';

/**
 * What a host's squad rule means when it is absent — no restriction, which is
 * what Remnawave's own column defaults to and how every panel before 3.4
 * behaved. Only reachable from a payload this version's mapper did not build.
 */
const NO_SQUAD_RULE = { mode: 'exclude', squads: [] } as const;
/**
 * Short enough that a node going down shows up while the customer is still
 * looking; long enough that a burst of double taps is four calls, not four
 * hundred.
 */
const SNAPSHOT_TTL_SECONDS = 20;

/** For the reason given before a snapshot has been read. */
const EMPTY_SNAPSHOT: PanelSnapshot = { hosts: [], nodes: [], squads: [], externalSquads: [] };

interface PanelSnapshot {
  readonly hosts: readonly RemnawaveHostInterface[];
  readonly nodes: readonly RemnawaveNodeInterface[];
  readonly squads: readonly RemnawaveInternalSquadDetailInterface[];
  /**
   * The external squads that relabel host badges. Optional for the reason
   * `serverDescription` is optional on a host — the specs build snapshots by
   * hand — and read as "none" when absent, which is also what a snapshot from
   * before this field means.
   */
  readonly externalSquads?: readonly RemnawaveExternalSquadHostOverrideInterface[];
}

/**
 * The part of a list that belongs to ONE subscriber: applied over the shared
 * snapshot on every request, and never stored in it.
 */
export interface SubscriberView {
  /** `Subscription.externalSquad`, whose badge override applies. */
  readonly externalSquad: string | null;
  /** The subscription's status, for a remark's `{{STATUS}}`. */
  readonly status: SubscriptionStatus | null;
  /** The subscription's expiry, for `{{DAYS_LEFT}}` and `{{EXPIRE_UNIX}}`. */
  readonly expiresAt: Date | null;
  /** `Subscription.remnawavePanelUsername`, for `{{USERNAME}}`. */
  readonly panelUsername: string | null;
  /** Epoch milliseconds that `{{DAYS_LEFT}}` counts from. */
  readonly now: number;
}

/**
 * A subscriber nothing is known about — in no external squad, and every remark
 * variable left out. What the pure functions assume when a spec does not say.
 */
const UNKNOWN_SUBSCRIBER: SubscriberView = {
  externalSquad: null,
  status: null,
  expiresAt: null,
  panelUsername: null,
  now: 0,
};

/**
 * Every format Remnawave builds a subscription in. The same six in every
 * Remnawave contract from 2.7.4 through 3.x — each enumerates exactly these —
 * and each of its config generators skips a host whose
 * `excludeFromSubscriptionTypes` names that generator's own format.
 */
const SUBSCRIPTION_FORMATS = [
  'XRAY_JSON',
  'XRAY_BASE64',
  'MIHOMO',
  'STASH',
  'CLASH',
  'SINGBOX',
] as const;

/**
 * True when the operator kept this host out of every subscription format, so
 * that no app receives it: hidden in all but name.
 *
 * Out of SOME formats is deliberately not enough. An app on one of the others
 * still gets the host, and nothing here knows which app a customer uses — so
 * the host stays in their list rather than vanishing for everyone.
 */
function reachesNoApp(host: RemnawaveHostInterface): boolean {
  const excluded = new Set(host.excludeFromSubscriptionTypes ?? []);
  return SUBSCRIPTION_FORMATS.every((format) => excluded.has(format));
}

/**
 * The tag that makes a host a section header in the customer's list.
 *
 * WHY A TAG. Remnawave has no separator concept. Operators fake section
 * headers with an ordinary host whose remark is a heading ("⬇️ Все | Локации
 * ⬇️", often with a badge such as "РАЗДЕЛИТЕЛЬ | НЕ СЕРВЕР"), VPN apps draw it
 * as a row reading "n/a", and this list drew it as a server with no data.
 * Nothing on the host tells the two apart. A working virtual host can sit on
 * `0.0.0.0`, and a working CDN host addressed by domain matches no node either,
 * so any automatic rule would sooner or later draw a server somebody pays for
 * as a heading — no status, no uptime, never recommended. The operator knows
 * which hosts are headers; a tag is where Remnawave lets them say so.
 *
 * NO NEW CALL AND NO CACHE KEY BUMP. `mapHost` has produced `tags` on every
 * host since 2.8 support (June 2026, before this list existed), folding 2.7's
 * single `tag` into a one-element array, so every snapshot ever cached under
 * `SNAPSHOT_CACHE_KEY` already carries it. Reading it changes no stored shape.
 *
 * THE SPELLING. Remnawave's create and update schemas accept host tags matching
 * `^[A-Z0-9_:]+$` only — at most 36 characters each from 2.8 on, 32 for 2.7's
 * single `tag` — so a lowercase or hyphenated marker could not be typed in at
 * all. The `REZEIS:` prefix keeps it clear of whatever the operator already
 * uses tags for.
 *
 * EXACT AND CASE-SENSITIVE, deliberately; host tags are not lowercased here. A
 * tag Remnawave would have refused can only come from a row edited by hand, and
 * the two ways of guessing wrong are not equal: a header missed stays the grey
 * row it has always been, while a server mistaken for a header loses its status
 * in front of the customer who uses it.
 */
const SEPARATOR_TAG = 'REZEIS:SEPARATOR';

/**
 * Whether the operator tagged this host as a section header.
 *
 * `Array.isArray` rather than the type, for the reason `NO_SQUAD_RULE` exists:
 * this reads a snapshot back out of Redis with an unchecked cast. `tags` has
 * been in every snapshot this list has cached, so this should never see a row
 * without it — and if it does, the host reads as the server it was on every
 * version before this one, where a throw would empty the list for everybody.
 */
function isSeparator(host: RemnawaveHostInterface): boolean {
  return Array.isArray(host.tags) && host.tags.includes(SEPARATOR_TAG);
}

/**
 * Filters the snapshot down to what these squads reach, describes each one for
 * this subscriber, and drops any section header left with no server under it.
 *
 * Exported for the spec: the interesting behaviour is all in here, and testing
 * it through the service would mean standing up Prisma and Redis to assert
 * something that is a pure function of three arrays.
 */
export function buildServers(
  squadUuids: readonly string[],
  snapshot: PanelSnapshot,
  subscriber: SubscriberView = UNKNOWN_SUBSCRIBER,
): readonly SubscriberServerInterface[] {
  const nodesByUuid = new Map(snapshot.nodes.map((node) => [node.uuid, node]));
  const badge = badgeOverride(snapshot, subscriber.externalSquad);
  return withoutEmptySections(
    listedHosts(squadUuids, snapshot).map((host) =>
      describeHost(host, nodesByUuid, subscriber, badge),
    ),
  );
}

/**
 * The badge this subscriber's external squad puts on every host they receive:
 * a string, `null` for no badge at all, or `undefined` when their squad
 * overrides nothing — or they are in none — and each host keeps its own.
 *
 * Remnawave's rule, from `applyHostOverrides`: a squad's `serverDescription`,
 * when it sets one, wins over every host's, `null` included. The mapper has
 * already dropped every squad that sets none (`mapExternalSquadHostOverrides`).
 * `?? []` for the reason `NO_SQUAD_RULE` exists: the snapshot comes back out of
 * Redis unchecked.
 */
function badgeOverride(
  snapshot: PanelSnapshot,
  externalSquad: string | null,
): string | null | undefined {
  if (externalSquad === null) return undefined;
  const squad = (snapshot.externalSquads ?? []).find((entry) => entry.uuid === externalSquad);
  return squad?.serverDescription;
}

/**
 * The hosts served to these squads, in the operator's order: every filter
 * applied, nothing described yet.
 *
 * A host tagged as a section header goes through exactly the same filters as
 * any other, and only one that would have been listed becomes a header. A
 * hidden header is hidden; a header kept out of this customer's squads is not
 * theirs to see. Nothing here looks at the tag.
 *
 * Its own function so that `explainEmpty` can ask the question this list was
 * built with, rather than a copy of it that could drift.
 */
function listedHosts(
  squadUuids: readonly string[],
  snapshot: PanelSnapshot,
): RemnawaveHostInterface[] {
  const reachedBy = squadsByInbound(squadUuids, snapshot.squads);
  if (reachedBy.size === 0) return [];

  return snapshot.hosts
    .filter((host) => {
      // A hidden or disabled host is not in the customer's config, so it is not
      // one of their servers — the list says "available", and showing an
      // unreachable entry as merely "offline" would be a different claim.
      if (host.isHidden || host.isDisabled) return false;
      // The same claim one step on: a host kept out of every subscription
      // format is in no app's config either.
      if (reachesNoApp(host)) return false;
      if (host.configProfileInboundUuid === null) return false;
      const squads = reachedBy.get(host.configProfileInboundUuid);
      if (squads === undefined) return false;
      // Reaching the inbound is not enough: the host names squads, and what
      // that naming MEANS is its mode. Remnawave settles both directions with
      // one equality, and this is the same one: a squad carries the host when
      // "this squad is named" equals "the mode is allow-only". Exclusions and
      // an allow list are that test read in two directions. The host belongs
      // in this list while at least one squad that got the customer here
      // carries it — a customer in two squads keeps a host the second one
      // excludes, and keeps one that allows only the first.
      // `?? NO_SQUAD_RULE` is not defensive programming for its own sake: the
      // snapshot below is cached in Redis as JSON, so a panel that has just
      // been upgraded can read a snapshot written by the version before it, in
      // which this field does not exist. The cache key carries a shape version
      // for exactly that reason and this should now be unreachable — but an
      // unguarded destructure turns one stale key into a 500 on the only screen
      // whose whole job is to answer "which servers do I have", for every
      // subscriber at once, and the guard costs nothing.
      const { mode, squads: named } = host.internalSquads ?? NO_SQUAD_RULE;
      const listed = new Set(named);
      const allowOnly = mode === 'allow-only';
      for (const squad of squads) {
        if (listed.has(squad) === allowOnly) return true;
      }
      return false;
    })
    // The order is the operator's, and a header is ordered like any host: it
    // keeps exactly the place it had when it was drawn as a server. `sort` is
    // stable, so hosts sharing a position keep the panel's own order too.
    .sort((a, b) => a.viewPosition - b.viewPosition);
}

/**
 * Drops every section header with no server under it.
 *
 * A header promises that servers follow, and the filters break that promise
 * per customer: a section whose hosts are hidden, kept out of this customer's
 * squads, or kept out of every format is empty for THIS customer, while its
 * header — which passed the same filters — is still standing. So the rule is
 * read off the finished list, not off the snapshot:
 *
 *   • a header followed by at least one server before the next header, or
 *     before the end of the list, stays;
 *   • a header followed directly by another header goes, so of a run of
 *     headers only the LAST one before a server survives. That is the one
 *     sitting over the servers that are actually there; the ones above it
 *     named sections that came out empty. Keeping the first instead would
 *     put the heading of an emptied section over servers from another one;
 *   • a header at the very end goes: it heads nothing.
 *
 * Servers above the first header stay where the operator put them, unlabelled.
 * A list of nothing but headers comes out empty, and `explainEmpty` says so.
 */
function withoutEmptySections(
  rows: readonly SubscriberServerInterface[],
): SubscriberServerInterface[] {
  const kept: SubscriberServerInterface[] = [];
  let header: SubscriberServerInterface | null = null;
  for (const row of rows) {
    if (row.kind === 'separator') {
      // Replaces a header nothing has followed yet.
      header = row;
      continue;
    }
    if (header !== null) kept.push(header);
    header = null;
    kept.push(row);
  }
  // A header still waiting here has no server under it.
  return kept;
}

export interface EmptyReason {
  /**
   * `debug` for a state the operator chose, `warn` for a link that is broken.
   *
   * The split is the difference between "your plan has no squads, so this
   * screen is empty on purpose" and "no host on this panel names an inbound",
   * and it matters because `SystemLogsService` floors at `log` in production:
   * anything `debug` never reaches the Logs page, and anything `warn` reaches
   * it on every install without the operator changing a setting.
   */
  readonly level: 'debug' | 'warn';
  readonly reason: string;
}

/**
 * Which link of the chain came up empty, in one sentence.
 *
 * Reads left to right along subscription -> squads -> inbounds -> hosts and
 * stops at the first break, because the first break explains every one after
 * it. The host links are read over the SERVERS, and over the section headers
 * only when there is no server at all: a header is never shown without a server
 * under it, so while there are servers, their break is the reason. The last
 * link is the one past every filter: headers that did reach the customer, with
 * no server under them. Counts rather than identifiers: this goes to a log an
 * operator reads, and host UUIDs would tell them nothing they could act on.
 *
 * Exported for the spec, and pure for the same reason as its neighbours.
 */
export function explainEmpty(
  squadUuids: readonly string[],
  snapshot: PanelSnapshot,
): EmptyReason {
  if (squadUuids.length === 0) {
    // The operator's own doing: a plan with no squads.
    return { level: 'debug', reason: 'the subscription has no squads (check the plan)' };
  }
  if (snapshot.squads.length === 0) {
    return { level: 'warn', reason: 'the panel returned no internal squads at all' };
  }
  const known = snapshot.squads.filter((squad) => squadUuids.includes(squad.uuid));
  if (known.length === 0) {
    return {
      level: 'warn',
      reason: `none of the ${squadUuids.length} squad(s) on the subscription exist in the panel`,
    };
  }
  const reachable = new Set(known.flatMap((squad) => [...squad.inboundUuids]));
  if (reachable.size === 0) {
    return { level: 'warn', reason: `${known.length} squad(s) matched but carry no inbounds` };
  }
  if (snapshot.hosts.length === 0) {
    return { level: 'warn', reason: 'the panel returned no hosts' };
  }
  // A header that passes every filter keeps every count below this line above
  // zero, so a chain read over all hosts walked straight past a break on the
  // servers under it and blamed the tag — at `debug`, which production never
  // logs, for a server the operator has to fix. Headers are what is left to
  // explain only when there are no servers.
  const servers = snapshot.hosts.filter((host) => !isSeparator(host));
  const hosts = servers.length > 0 ? servers : snapshot.hosts;
  const linked = hosts.filter((host) => host.configProfileInboundUuid !== null);
  if (linked.length === 0) {
    // The shipped regression, in one line. Nobody configures this.
    return {
      level: 'warn',
      reason: `none of the ${hosts.length} host(s) name an inbound`,
    };
  }
  const matching = linked.filter(
    (host) =>
      host.configProfileInboundUuid !== null &&
      reachable.has(host.configProfileInboundUuid),
  );
  if (matching.length === 0) {
    return {
      level: 'warn',
      reason: `${linked.length} linked host(s), none on the ${reachable.size} inbound(s) these squads reach`,
    };
  }
  const visible = matching.filter((host) => !host.isHidden && !host.isDisabled);
  if (visible.length === 0) {
    // Deliberate again: hiding and disabling are buttons the operator pressed.
    return {
      level: 'debug',
      reason: `${matching.length} matching host(s), all hidden or disabled`,
    };
  }
  const delivered = visible.filter((host) => !reachesNoApp(host));
  if (delivered.length === 0) {
    // The operator's own doing too, and a different fix from unhiding: the
    // formats are unticked on the host itself.
    return {
      level: 'debug',
      reason: `${visible.length} matching host(s), all kept out of every subscription format`,
    };
  }
  const listed = listedHosts(squadUuids, { ...snapshot, hosts });
  if (listed.length === 0) {
    return {
      level: 'debug',
      reason: `${delivered.length} matching host(s), none of them served to these squads`,
    };
  }
  // Every filter passed, and the list is still empty. A server past every
  // filter is always shown, so what passed is headers alone — `hosts` fell back
  // to them above — none with a server under it. The operator's own doing like
  // the three above — they tagged them — so it does not shout. Last, so it
  // never speaks over a break earlier in the chain: a tagged host that is also
  // hidden, or unticked, or not served to these squads, is reported as that.
  return {
    level: 'debug',
    reason: `${listed.length} host(s) served to these squads, all of them separators tagged ${SEPARATOR_TAG}`,
  };
}

/**
 * Inbound UUID -> the customer's own squads that reach it.
 *
 * A flat set of inbound UUIDs would do if a host could not opt out of a squad.
 * It can (`internalSquads`), so "may this customer use this host"
 * depends on WHICH squad brought them to its inbound, and the answer has to
 * survive as far as the filter.
 */
function squadsByInbound(
  squadUuids: readonly string[],
  squads: readonly RemnawaveInternalSquadDetailInterface[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const wanted = new Set(squadUuids);
  const reachedBy = new Map<string, Set<string>>();
  for (const squad of squads) {
    if (!wanted.has(squad.uuid)) continue;
    for (const inbound of squad.inboundUuids) {
      const existing = reachedBy.get(inbound);
      if (existing) existing.add(squad.uuid);
      else reachedBy.set(inbound, new Set([squad.uuid]));
    }
  }
  return reachedBy;
}

/**
 * The nodes that actually carry a host's traffic.
 *
 * FIRST the explicit link: `host.nodes`, the list the operator keeps on the
 * host in Remnawave. When it resolves to at least one node that exists, it is
 * the answer — including when that node is disabled, because pointing a host
 * at a switched-off node is a deliberate act and this list must not
 * second-guess it.
 *
 * THEN, and only when that link resolves to NOTHING, the address. The link is
 * optional in Remnawave: a customer's VPN client connects to `host.address`
 * and never consults `host.nodes`, so a host whose list was never filled in —
 * or still names the UUID of a node that was deleted and recreated — carries
 * traffic perfectly well while this screen used to report it as "no data".
 * Reported from production on a restored server: the client connected at
 * 101 ms, the node was online, and the customer's list said nothing was known.
 * Nodes come and go as a matter of course — a restore, a move to another
 * provider, a rebuild — so an identity only the explicit link can supply is
 * not one this list can depend on. The node at the host's address is the one
 * serving it.
 *
 * Ambiguity is not an answer: if two nodes share the address, neither is
 * chosen, because reporting the state of the wrong server would be worse than
 * saying nothing. No DNS is resolved either — a host addressed by name and a
 * node addressed by IP stay unmatched rather than being joined by a lookup
 * this hot path has no business making.
 *
 * The addresses are read here and never emitted: `describeHost` still returns
 * only the fields `SubscriberServerInterface` names, and none of them is an
 * address. A section header never gets this far — see `describeSeparator`.
 */
function nodesServing(
  host: RemnawaveHostInterface,
  nodesByUuid: ReadonlyMap<string, RemnawaveNodeInterface>,
): RemnawaveNodeInterface[] {
  const linked = host.nodes
    .map((uuid) => nodesByUuid.get(uuid))
    .filter((node): node is RemnawaveNodeInterface => node !== undefined);
  if (linked.length > 0) return linked;

  const address = normalizeAddress(host.address);
  if (address === '') return [];
  const atAddress = [...nodesByUuid.values()].filter(
    (node) =>
      normalizeAddress(node.address) === address ||
      node.ips.some((entry) => normalizeAddress(entry.ip) === address),
  );
  return atAddress.length === 1 ? atAddress : [];
}

/** Case, surrounding whitespace and IPv6 brackets are not part of an address. */
function normalizeAddress(value: string): string {
  return value.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function describeHost(
  host: RemnawaveHostInterface,
  nodesByUuid: ReadonlyMap<string, RemnawaveNodeInterface>,
  subscriber: SubscriberView,
  badge: string | null | undefined,
): SubscriberServerInterface {
  // Before the node lookup, not after it: a header describes no server, so it
  // must not borrow the state of one.
  if (isSeparator(host)) return describeSeparator(host, subscriber);

  const nodes = nodesServing(host, nodesByUuid);

  // The name is the REMARK — the string the customer already reads as the
  // server's name inside their VPN client — and `serverDescription` is the
  // badge under it. Checked against a client rather than reasoned about: Incy
  // draws "Germany - 1" in large type over a chip reading "ОСНОВНОЙ | СЕРВЕР".
  //
  // This used to be the other way round (0.9.7.52 preferred the description),
  // on the reading that the description is "the customer-facing line" and the
  // remark "internal naming". Both strings are customer-facing; they are a
  // title and a label. Operators write the description as a category and
  // repeat it across hosts on purpose, so a real list rendered "ОСНОВНОЙ |
  // СЕРВЕР" five times over five countries. If a remark reads like internal
  // naming, the customer is reading it in Happ and Incy too, and the fix for
  // both is renaming the host in Remnawave — not a second opinion here.
  //
  // Rendered for this subscriber first, as Remnawave renders it before any
  // client sees it — see `renderRemark`. Everything below reads the result.
  const name = renderRemark(host.remark, subscriber);
  // Their external squad's badge replaces the host's own, and its `null`
  // removes it, exactly as `applyHostOverrides` does — see `badgeOverride`.
  const label = badge !== undefined ? badge : host.serverDescription;
  const described = label?.trim() ?? '';
  const description =
    described === '' || sameLabel(described, name) ? null : described;

  const { flag, countryCode } = resolveHostCountry(
    // From the name, then from the nodes — the flag belongs to the NAME,
    // which the cabinet strips the flag back out of and draws beside it. A
    // flag inside the description stays inside the badge, as it does in the
    // client; it is not promoted into the flag slot, which would otherwise let
    // a category chip such as "🇪🇺 AUTO" relabel a German server as EU.
    name,
    nodes.map((node) => node.countryCode),
  );

  const live = nodes.filter((node) => !node.isDisabled);
  const connected = live.filter((node) => node.isConnected);

  return {
    id: host.uuid,
    kind: 'server',
    name,
    description,
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

/**
 * A section header: the operator's words, and nothing that describes a server.
 *
 * NEVER MATCHED TO A NODE. A header host still has an address and can still
 * list nodes — it is an ordinary host in Remnawave, and one copied from a
 * working host keeps both. Before headers were recognised, one that shared a
 * node's address read as online, carried that node's uptime and load, and
 * could be named the least busy server of all. So nothing below reads a node:
 * no flag or country (there is no place), `unknown` (there is no state), and no
 * uptime or load. The badge goes too — on a header it is the category the
 * operator wrote to label the row a separator, which the header now shows by
 * being one.
 *
 * Those values are also the whole of the fallback: a cabinet that predates
 * `kind` drops it, and a row reading `unknown` with nothing else is the grey
 * "no data" row such a cabinet has always drawn for this host — only without
 * the badge.
 *
 * The heading is rendered like any remark: an info row such as "Осталось
 * {{DAYS_LEFT}} дн." is the obvious thing to tag, and the client renders it.
 */
function describeSeparator(
  host: RemnawaveHostInterface,
  subscriber: SubscriberView,
): SubscriberServerInterface {
  return {
    id: host.uuid,
    kind: 'separator',
    name: renderRemark(host.remark, subscriber),
    description: null,
    flag: null,
    countryCode: null,
    status: 'unknown',
    uptimeSeconds: null,
    usersOnline: null,
  };
}

/**
 * Remnawave's own token pattern, `TEMPLATE_REGEX` in
 * `src/common/utils/templates/template-parser.ts` (unchanged 3.2.1 through
 * 3.4.4; the engine before that file, through 3.2.0, matched `{{KEY}}` alone):
 * `{{KEY}}`, or `{{KEY:args}}` with args that hold no brace.
 */
const REMARK_TOKEN = /\{\{(\w+)(?::([^{}]*))?\}\}/g;

/**
 * The marker that asks Remnawave to send a remark encoded — `BASE64_ENCODE_PREFIX`
 * in the same `template-parser.ts`, and the same string in the engine every
 * earlier 3.x release shipped. See `renderRemark`.
 */
const BASE64_ENCODE_MARKER = 'rwEncodeBase64:';

/**
 * Every variable Remnawave substitutes into a remark, as of panel 3.4.4 —
 * `libs/contract/constants/templates/template-keys.ts`. 3.2 through 3.4.3 know
 * the same list less `LAST_TRAFFIC_RESET_AT`, `NEXT_TRAFFIC_RESET_AT_UNIX` and
 * `NEXT_TRAFFIC_RESET_AT`, which those releases leave in braces; no operator on
 * them types a token their clients print raw.
 *
 * The spec holds this to each 3.x contract oracle's own `TEMPLATE_KEYS`: a key
 * missing here would reach a customer in braces.
 */
const REMARK_VARIABLES: ReadonlySet<string> = new Set([
  'DAYS_LEFT',
  'TRAFFIC_USED',
  'TRAFFIC_LEFT',
  'STATUS',
  'TOTAL_TRAFFIC',
  'USERNAME',
  'EMAIL',
  'TELEGRAM_ID',
  'SUBSCRIPTION_URL',
  'TAG',
  'EXPIRE_UNIX',
  'SHORT_UUID',
  'ID',
  'TRAFFIC_USED_BYTES',
  'TRAFFIC_LEFT_BYTES',
  'TOTAL_TRAFFIC_BYTES',
  'RESET_STRATEGY',
  'LIFETIME_USED_BYTES',
  'CREATED_AT_UNIX',
  'LAST_TRAFFIC_RESET_AT_UNIX',
  'LAST_TRAFFIC_RESET_AT',
  'NEXT_TRAFFIC_RESET_AT_UNIX',
  'NEXT_TRAFFIC_RESET_AT',
  'SS_HWID_LIMIT',
  'DESCRIPTION',
]);

const DAY_MS = 86_400_000;

/**
 * A host remark as this subscriber's VPN client shows it.
 *
 * Remnawave never sends a remark as stored. Before a config goes out it renders
 * the remark for that one user — `TemplateEngine.replace(inputHost.remark,
 * userValueMap)` in `resolve-proxy-config.service.ts` — so an operator's info
 * row "Осталось {{DAYS_LEFT}} дн." reads "Осталось 12 дн." in Happ and Incy.
 * This renders it the same way, per request and never into the shared snapshot,
 * because every value in it belongs to one subscriber.
 *
 * WHAT THE PANEL KNOWS, filled in the way `createUserValueMap` formats it:
 *   • `DAYS_LEFT` — whole days until `expiresAt`, rounded down, never below 0;
 *   • `EXPIRE_UNIX` — `expiresAt` in whole seconds;
 *   • `STATUS` — the operator's own word for this status when the token gives
 *     one (`{{STATUS:ACTIVE=…|EXPIRED=…}}`), otherwise "Active", "Expired", …;
 *   • `USERNAME` — the panel username the profile was created or linked under.
 *
 * WHAT IT CANNOT KNOW is left out, and the gap closed — whitespace collapsed,
 * the ends trimmed — so "Germany | {{TRAFFIC_LEFT}}" reads "Germany |". Every
 * client shows some value there and none shows braces, so a blank is the only
 * honest rendering. That covers every traffic figure (usage is counted in
 * Remnawave and never stored here; the limit Remnawave holds can include add-on
 * traffic written from the effective projection rather than the plan, and its
 * wording comes from a byte-formatting library), the device limit (the same
 * projection), and each fact about the panel's own copy of the user: email,
 * Telegram id, tag, description, id, short uuid, subscription URL, creation and
 * reset dates, reset strategy.
 *
 * A token Remnawave does not know stays exactly as written, as it does there,
 * and a remark with nothing left out is returned exactly as the operator wrote
 * it, less the marker below.
 *
 * THE `rwEncodeBase64:` MARKER is an instruction to the panel, never part of
 * the name. A remark that starts with it is sent encoded: every 3.x panel cuts
 * the marker off, renders what follows, and sends `base64:` plus the Base64 of
 * the result (`parseTransform`, then `renderTemplate`). An app that reads
 * `base64:` shows the rendered text, which is what this returns; the marker
 * reaches no app. It counts only where `startsWith` finds it — at the very
 * start, spelled exactly so, and once. Nothing is decoded here, because the
 * panel decodes nothing: a remark the operator stored as `base64:…` goes out
 * exactly as written.
 */
function renderRemark(remark: string, subscriber: SubscriberView): string {
  const body = remark.startsWith(BASE64_ENCODE_MARKER)
    ? remark.slice(BASE64_ENCODE_MARKER.length)
    : remark;
  let leftOut = false;
  const rendered = body.replace(
    REMARK_TOKEN,
    (token: string, key: string, args: string | undefined): string => {
      if (!REMARK_VARIABLES.has(key)) return token;
      const value = remarkValue(key, args, subscriber);
      if (value !== null) return value;
      leftOut = true;
      return '';
    },
  );
  return leftOut ? rendered.replace(/\s+/g, ' ').trim() : rendered;
}

/** One variable's value for this subscriber, or `null` when the panel cannot know it. */
function remarkValue(
  key: string,
  args: string | undefined,
  { status, expiresAt, panelUsername, now }: SubscriberView,
): string | null {
  switch (key) {
    case 'DAYS_LEFT':
      // `Math.max(0, dayjs(expireAt).diff(dayjs(), 'day'))`.
      return expiresAt === null
        ? null
        : String(Math.max(0, Math.floor((expiresAt.getTime() - now) / DAY_MS)));
    case 'EXPIRE_UNIX':
      return expiresAt === null ? null : String(Math.floor(expiresAt.getTime() / 1000));
    case 'STATUS':
      // `args[user.status] ?? USER_STATUS_LABELS[user.status]`.
      return status === null
        ? null
        : (statusWords(args).get(status) ?? status.charAt(0) + status.slice(1).toLowerCase());
    case 'USERNAME':
      return panelUsername;
    default:
      return null;
  }
}

/**
 * `ACTIVE=✅|EXPIRED=⛔` as a map, split the way Remnawave's `parseArgs` splits
 * it: pairs on `|`, the name trimmed, the word kept exactly as typed, and a pair
 * with no `=` ignored.
 */
function statusWords(args: string | undefined): ReadonlyMap<string, string> {
  const words = new Map<string, string>();
  for (const pair of (args ?? '').split('|')) {
    const at = pair.indexOf('=');
    if (at !== -1) words.set(pair.slice(0, at).trim(), pair.slice(at + 1));
  }
  return words;
}

/**
 * Whether a description only repeats the name, so the badge would say nothing
 * the title has not.
 *
 * Compared the way a person reads them: flags removed (the cabinet draws the
 * name's flag separately, so "🇩🇪 Germany" and "Germany" are the same words on
 * screen), runs of whitespace collapsed, and case ignored — "GERMANY" in a chip
 * under "Germany" is still the same word twice. Anything else is a different
 * label and keeps its badge; this is deliberately not a similarity measure.
 */
function sameLabel(a: string, b: string): boolean {
  const plain = (value: string): string =>
    value
      .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();
  return plain(a) === plain(b);
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
 *
 * Never a section header. `describeSeparator` already sends every header as
 * `unknown`, so the status test below would pass one over today — but a header
 * is not somewhere to connect whatever its status says, and a recommendation
 * that depended on how another function fills in a field it does not own would
 * break the first time that function changed.
 */
export function pickRecommended(
  servers: readonly SubscriberServerInterface[],
): string | null {
  let best: SubscriberServerInterface | null = null;
  for (const server of servers) {
    if (server.kind === 'separator') continue;
    if (server.status !== 'online') continue;
    if (best === null || (server.usersOnline ?? 0) < (best.usersOnline ?? 0)) {
      best = server;
    }
  }
  return best?.id ?? null;
}
