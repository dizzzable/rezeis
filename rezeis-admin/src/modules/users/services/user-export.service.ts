import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { PanelDevicesClient } from '../../remnawave/services/panel-devices.client';
import {
  needsPanelDevices,
  needsSubscription,
  type UserExportColumn,
} from '../utils/user-export.catalog';
import {
  renderUserExportCsv,
  type UserExportDevice,
  type UserExportRow,
} from '../utils/user-export.util';

/**
 * user-export.service
 * ───────────────────
 * The whole customer base, as a spreadsheet, with the columns the operator
 * asked for and nothing else.
 *
 * ── Why it is one query and at most one panel call ───────────────────────────
 *
 * The obvious shape — read the users, then ask the panel about each one's
 * devices — is one HTTP call per subscriber against the OPERATOR'S OWN
 * production panel. At sixty customers it is invisible; at ten thousand it is
 * an outage they caused by pressing Export. Remnawave's `GET /api/hwid/devices`
 * serves the same rows unfiltered, each carrying the panel id it belongs to, so
 * one paged walk replaces the whole N+1.
 *
 * It is only walked when a device column was actually ticked. An export of
 * names and emails must not touch the panel at all.
 *
 * ── An incomplete answer is reported, never rounded to zero ──────────────────
 *
 * The sweep can stop short — a ceiling, an unreachable panel — and the honest
 * thing to do with a user whose devices were not read is to leave those cells
 * EMPTY. A `0` in a device count is a finding: it says this person has
 * connected nothing, which an operator would act on. The export says how many
 * users it could not answer for rather than quietly inventing zeroes.
 */

/** What the caller settled on. Filters are the list page's, verbatim. */
export interface UserExportQuery {
  readonly where: Prisma.UserWhereInput;
  readonly columns: readonly UserExportColumn[];
  readonly limit: number;
}

export interface UserExportResult {
  readonly csv: string;
  readonly rowCount: number;
  /**
   * True when the ceiling stopped the export with customers still to write.
   *
   * Silent truncation is the failure this exists to prevent: an operator on a
   * base of 60 000 would otherwise get the oldest 20 000 rows, with nothing in
   * the file or the response saying the other 40 000 exist.
   */
  readonly truncated: boolean;
  /** Users whose device columns are blank because the panel was not read. */
  readonly usersWithoutDevices: number;
  /** True when device columns were asked for and the panel answered in full. */
  readonly devicesComplete: boolean | null;
}

/**
 * The ceiling on one export, and it is a MEASURED number.
 *
 * The file is built in memory before it is sent, and `renderUserExportCsv`
 * holds three full copies live at once: the cell matrix, the joined lines, and
 * the single result string. Measured at 50 000 rows × 42 columns with device
 * columns populated, that is a ~50 MB file and a **~700 MB** peak RSS on the
 * JS side alone — against a container limited to 1024 MB, before Prisma
 * materialises the rows or Express buffers the response. Nothing serialises
 * two operators pressing Export at the same moment.
 *
 * 20 000 keeps the same shape under ~300 MB, which leaves room for the rest of
 * the process and for a second export arriving beside it. It is a ceiling, not
 * a promise: an install with more customers than this gets the oldest 20 000
 * and is TOLD so, which is the half that was missing.
 */
export const USER_EXPORT_MAX_ROWS = 20_000;
export const USER_EXPORT_DEFAULT_ROWS = 20_000;

/**
 * How many exports this process will run at once — and it is ONE.
 *
 * ── The memory profile is BUFFERED, all the way down ─────────────────────────
 *
 * Nothing about this export streams. `findMany` materialises every selected
 * user with its subscriptions before a single cell is written;
 * `renderUserExportCsv` then holds three full copies live at once — the cell
 * matrix, the joined lines, and the one result string — and `response.send`
 * buffers that string again on its way out. The ceiling above is sized for one
 * run of that shape: ~300 MB at 20 000 rows against a container limited to
 * 1024 MB (`docker-compose.yml`, `deploy.resources.limits.memory: 1024M`).
 *
 * Three concurrent runs were measured at ≈900 MB, and the failure at the top of
 * that is not a slow export — it is the OOM killer taking the whole API
 * process. That logs nothing useful, drops every OTHER admin's session and
 * every in-flight request in the panel, and restarts into whatever the operator
 * presses next. One operator's second click must not be able to do that.
 *
 * ── Refused, not queued ──────────────────────────────────────────────────────
 *
 * Queuing would hold the second request's socket open behind a run that can
 * legitimately take minutes, which the reverse proxies in `deploy/proxies/`
 * cut at 120 s anyway — so the operator would get a timeout with no idea why.
 * A refusal they can read, and press again in a minute, is the honest answer.
 *
 * ── MULTI-REPLICA CAVEAT ─────────────────────────────────────────────────────
 *
 * This counter lives in ONE Node process. The shipped compose file runs a
 * single `rezeis` service with no `replicas:`, so it is the whole story there.
 * Anyone who scales that service behind the proxy gets one concurrent export
 * PER REPLICA, and the memory arithmetic above then has to be redone per
 * container — the guard bounds a process, never a cluster. Making it cluster-
 * wide means a lease in Postgres or Redis, which is a bigger change than the
 * failure justifies today.
 */
export const USER_EXPORT_MAX_CONCURRENT = 1;

/**
 * What the operator is told when the second export is refused.
 *
 * It says WHAT happened and WHAT TO DO, and names no host, port, container or
 * panel profile: the same sentence would be safe on a customer's screen, which
 * is the standing rule for every string this codebase puts on a wire.
 */
export const USER_EXPORT_BUSY_MESSAGE =
  'An export is already running. Wait for it to finish, then press Export again.';

export function clampUserExportLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return USER_EXPORT_DEFAULT_ROWS;
  return Math.max(1, Math.min(Math.trunc(limit), USER_EXPORT_MAX_ROWS));
}

/**
 * What one walk of the panel's device inventory produced.
 *
 * `complete` travels WITH the map because the two are only meaningful
 * together: a map missing an entry means "this customer has no devices" after a
 * finished walk and "we did not get that far" after a truncated one, and the
 * caller has to be able to tell those apart before it writes a number.
 */
interface PanelDeviceSweep {
  readonly byPanelId: Map<number, UserExportDevice[]>;
  readonly complete: boolean;
}

@Injectable()
export class UserExportService {
  private readonly logger = new Logger(UserExportService.name);

  /**
   * Exports in flight in THIS process. See `USER_EXPORT_MAX_CONCURRENT`.
   *
   * A plain number is enough, and it is enough for the same reason a mutex
   * would be overkill: the read, the compare and the increment below sit in one
   * synchronous run of `exportCsv` with no `await` between them, so no second
   * request can observe the counter half-updated.
   */
  private running = 0;

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly panelDevices: PanelDevicesClient,
  ) {}

  public async exportCsv(query: UserExportQuery): Promise<UserExportResult> {
    // TAKEN BEFORE THE FIRST AWAIT, released in a `finally` that a thrown query
    // cannot skip. A slot leaked by a failed export would refuse every later
    // one for the lifetime of the process, which is a worse outage than the one
    // this prevents.
    if (this.running >= USER_EXPORT_MAX_CONCURRENT) {
      this.logger.warn(
        `A user export was refused: ${this.running} already running (ceiling ` +
          `${USER_EXPORT_MAX_CONCURRENT}) — the process would run out of memory`,
      );
      throw new ConflictException(USER_EXPORT_BUSY_MESSAGE);
    }
    this.running += 1;
    try {
      return await this.buildCsv(query);
    } finally {
      this.running -= 1;
    }
  }

  private async buildCsv(query: UserExportQuery): Promise<UserExportResult> {
    const wantsSubscription = needsSubscription(query.columns);
    const wantsDevices = needsPanelDevices(query.columns);

    const users = await this.prismaService.user.findMany({
      where: query.where,
      // Oldest first, so an export taken twice a week apart shares a prefix and
      // can be diffed. Newest-first would shift every row by the week's signups.
      orderBy: { createdAt: 'asc' },
      take: query.limit,
      select: {
        id: true,
        telegramId: true,
        username: true,
        name: true,
        email: true,
        language: true,
        role: true,
        referralCode: true,
        isBlocked: true,
        isBotBlocked: true,
        createdAt: true,
        lastSeenAt: true,
        points: true,
        personalDiscount: true,
        pwaInstalledAt: true,
        lastSurface: true,
        lastFormFactor: true,
        lastOs: true,
        onboardingCompletedAt: true,
        firstTrafficAt: true,
        registrationChannel: true,
        acquisitionPlacementId: true,
        acquisitionAt: true,
        registrationIp: true,
        registrationUserAgent: true,
        registrationReferer: true,
        registrationUtm: true,
        // The subscription join is paid for only when a column needs it, and
        // the panel id comes with it because that is what a device row is keyed
        // by — asking for devices without it would leave every row unmatched.
        ...(wantsSubscription || wantsDevices
          ? {
              // NON-DELETED only, both times. The list's filters exclude
              // DELETED from every subscription term on principle, so an
              // operator who filtered "has no subscription" and ticked this
              // column got rows selected BECAUSE they have none, carrying a 3.
              _count: {
                select: { subscriptions: { where: { status: { not: 'DELETED' } } } },
              },
              // THE SUBSCRIPTION COLUMNS COME FROM HERE, NOT FROM
              // `currentSubscription`.
              //
              // `User.currentSubscriptionId` is a pointer that is only ever
              // set when it is already null — every writer does
              // `where: { currentSubscriptionId: null }` — and deletion never
              // clears it, because deletion is a soft delete that sets
              // `status: DELETED`. So a customer who cancelled plan A and
              // bought plan B still points at A, for ever.
              //
              // Reading the pointer put A's dead expiry date in the "Subscription
              // ends" column of a paying customer — under a header an operator
              // filters on to decide who to mail. The newest non-DELETED row is
              // what "the subscription this customer has" means, and it is the
              // same relation the device join already trusts for panel ids.
              subscriptions: {
                where: { status: { not: 'DELETED' } },
                orderBy: { createdAt: 'desc' },
                select: {
                  remnawavePanelId: true,
                  ...(wantsSubscription
                    ? {
                        status: true,
                        planSnapshot: true,
                        expiresAt: true,
                        isTrial: true,
                        trafficLimit: true,
                        deviceLimit: true,
                      }
                    : {}),
                },
              },
            }
          : {}),
      },
    });

    const sweep = wantsDevices ? await this.readPanelDevices() : null;
    const devicesByPanelId = sweep?.byPanelId ?? null;
    let usersWithoutDevices = 0;

    const rows: UserExportRow[] = users.map((user) => {
      const live = ((user as { subscriptions?: CurrentSubscription[] }).subscriptions ?? []);
      // Newest first from the query, so index 0 is the one in force. Undefined
      // when every subscription this customer ever had is deleted — which is
      // "no subscription", and every column below then reads empty.
      const current = live[0];
      const panelIds = live
        .map((subscription) => subscription.remnawavePanelId)
        .filter((panelId): panelId is number => typeof panelId === 'number');

      let devices: UserExportDevice[] | null = null;
      if (devicesByPanelId !== null && panelIds.length > 0) {
        const found = panelIds.flatMap((panelId) => devicesByPanelId.get(panelId) ?? []);
        // A PARTIAL SWEEP MAY NOT WRITE A ZERO.
        //
        // The walk stops at a ceiling. Past it, a customer who really does have
        // devices simply is not in the map — indistinguishable, here, from one
        // who has none. Writing `0` for them is the same false finding this
        // file refuses everywhere else, and it landed on precisely the large
        // installations where the device columns matter: an operator reading
        // "0 devices" for a subscriber who is connected right now.
        //
        // Empty is the honest answer for "we did not see". A customer the walk
        // DID reach and found nothing for is still a real zero, so a non-empty
        // result is kept as-is either way.
        devices = found.length > 0 || sweep?.complete === true ? found : null;
      }
      // EMPTY, NOT ZERO, for a subscription that carries no panel id. The
      // column is written opportunistically whenever a panel row is read, so a
      // null does NOT mean "this customer has no profile" — it means we have
      // not seen one. A `0` there is a finding the export is not entitled to.
      if (wantsDevices && devices === null) usersWithoutDevices += 1;

      return {
        id: user.id,
        telegramId: user.telegramId,
        username: user.username,
        name: user.name,
        email: user.email,
        language: user.language,
        role: user.role,
        referralCode: user.referralCode,
        isBlocked: user.isBlocked,
        isBotBlocked: user.isBotBlocked,
        createdAt: user.createdAt,
        lastSeenAt: user.lastSeenAt,
        points: user.points,
        personalDiscount: user.personalDiscount,
        pwaInstalledAt: user.pwaInstalledAt,
        lastSurface: user.lastSurface,
        lastFormFactor: user.lastFormFactor,
        lastOs: user.lastOs,
        onboardingCompletedAt: user.onboardingCompletedAt,
        firstTrafficAt: user.firstTrafficAt,
        registrationChannel: user.registrationChannel,
        acquisitionPlacementId: user.acquisitionPlacementId,
        acquisitionAt: user.acquisitionAt,
        registrationIp: user.registrationIp,
        registrationUserAgent: user.registrationUserAgent,
        registrationReferer: user.registrationReferer,
        registrationUtm: user.registrationUtm,
        subscription:
          current === undefined || current === null
            ? null
            : {
                status: current.status,
                planName: readPlanName(current.planSnapshot),
                expiresAt: current.expiresAt,
                isTrial: current.isTrial,
                trafficLimit: current.trafficLimit,
                deviceLimit: current.deviceLimit,
              },
        subscriptionCount:
          (user as { _count?: { subscriptions: number } })._count?.subscriptions ?? null,
        devices,
      };
    });

    return {
      csv: renderUserExportCsv(query.columns, rows),
      rowCount: rows.length,
      // `take` returns at most `limit`, so a full page is the signal that the
      // query had more to give. It over-reports by one page-exact export in
      // every `limit` — which is the safe direction for a warning.
      truncated: rows.length >= query.limit,
      usersWithoutDevices,
      // `true` only when the panel answered AND the walk finished. A partial
      // sweep used to report `true` here, so the audit row said the device
      // columns were authoritative on the one run where they were not.
      devicesComplete: wantsDevices ? sweep !== null && sweep.complete : null,
    };
  }

  /**
   * Every device the panel holds, grouped by the profile it belongs to.
   *
   * `null` when the panel could not be read AT ALL, which the caller turns into
   * empty device cells rather than zeroes. A partial walk is kept — the rows it
   * did read are true — and reported through the log, because the alternative,
   * discarding a nearly complete inventory over one short page, would make the
   * device columns useless on exactly the large installations that need them.
   */
  private async readPanelDevices(): Promise<PanelDeviceSweep | null> {
    const outcome = await this.panelDevices.listAllDevices();
    if (outcome.kind !== 'ok') {
      this.logger.warn(
        `User export asked for device columns and the panel did not answer (${outcome.kind}); ` +
          'those columns will be empty rather than zero',
      );
      return null;
    }
    if (!outcome.data.complete) {
      this.logger.warn(
        `User export read ${outcome.data.devices.length} of ${outcome.data.total} devices — ` +
          'the device columns under-report for this run',
      );
    }

    const complete = outcome.data.complete;
    const byPanelId = new Map<number, UserExportDevice[]>();
    for (const device of outcome.data.devices) {
      const owner = device.userId;
      if (typeof owner !== 'number') continue;
      const list = byPanelId.get(owner) ?? [];
      list.push({
        hwid: device.hwid,
        platform: device.platform ?? null,
        userAgent: device.userAgent ?? null,
        deviceName: device.deviceModel ?? null,
        lastSeenAt: readDeviceSeenAt(device),
      });
      byPanelId.set(owner, list);
    }
    return { byPanelId, complete };
  }
}

interface CurrentSubscription {
  readonly status: string;
  readonly planSnapshot: unknown;
  readonly expiresAt: Date | null;
  readonly isTrial: boolean;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly remnawavePanelId: number | null;
}

/**
 * The plan's name out of the snapshot.
 *
 * The snapshot, not the plan row: a plan renamed or deleted after the purchase
 * must not rewrite what an old export says the customer bought. That is the
 * whole reason the snapshot exists.
 */
function readPlanName(snapshot: unknown): string | null {
  if (snapshot === null || typeof snapshot !== 'object') return null;
  const name = (snapshot as Record<string, unknown>)['name'];
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/**
 * `lastSeenAt` where the build has it, `updatedAt` where it does not.
 *
 * A `Date` IS ACCEPTED, and refusing one was the bug. The contract package
 * declares `updatedAt` as `z.iso.datetime().transform(str => new Date(str))`,
 * so on the validated path — that is, on every healthy panel — the value that
 * arrives here is already a `Date`. A `typeof seen === 'string'` test threw it
 * away, and the column came back blank for every device of every customer. It
 * populated only when the panel's answer FAILED validation and raw JSON leaked
 * through, which is the exact inverse of what anyone would guess from the data.
 */
function readDeviceSeenAt(device: Record<string, unknown>): string | null {
  const seen = device['lastSeenAt'] ?? device['updatedAt'];
  if (seen instanceof Date) return Number.isNaN(seen.getTime()) ? null : seen.toISOString();
  if (typeof seen !== 'string' || seen.length === 0) return null;
  const parsed = new Date(seen);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
