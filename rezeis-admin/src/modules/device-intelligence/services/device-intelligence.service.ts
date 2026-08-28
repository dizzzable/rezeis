import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  BlockedIdentityKind,
  DeviceSignalKind,
  Prisma,
  UserReviewFlagKind,
} from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { BlockedIdentityService } from '../../blocked-identities/services/blocked-identity.service';
import {
  deviceFlagFingerprint,
  normaliseDeviceSignal,
} from '../utils/device-signal.util';

/**
 * Device signals from the cabinet, and the quiet flag they raise.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * The bot knows a Telegram id and the VPN client reports a hardware id, but the
 * cabinet can be used without ever touching either — no Telegram account, and
 * no VPN client until after the first purchase. For a person banned from the
 * cabinet, a new mailbox and a new login is the whole cost of coming back.
 *
 * ── Why this never refuses anybody ────────────────────────────────────────
 *
 * A device match proves the same MACHINE, never the same person. A household
 * shares a laptop, an office deploys one image to two hundred of them, and a
 * library terminal touches dozens of accounts a day. Every one of those is
 * indistinguishable here from a ban evader.
 *
 * So the account is created and an operator is asked to look. That decision is
 * the reason the whole feature is worth having: a refusal on this evidence
 * would produce customers who cannot register and are never told why, and the
 * support cost of that dwarfs the fraud it prevents.
 *
 * ── And why the flag is invisible ────────────────────────────────────────
 *
 * {@link report} answers the same thing whether or not it raised a flag, and no
 * cabinet-facing projection reads the table. An evader who can see the flag
 * learns exactly which signal gave them away and what to change next time —
 * which turns a working signal into a training exercise.
 */
/**
 * How many distinct accounts may share one device signal before it stops
 * counting as a device.
 *
 * Six. A machine genuinely lent around a household reaches two or three; past
 * that the value is describing a browser configuration rather than hardware,
 * and the populations that produce identical digests — Tor, Firefox with
 * `resistFingerprinting`, Apple Silicon Safari — are thousands strong.
 *
 * Deliberately NOT operator-tunable. It is not a policy dial; it is the line
 * between a fingerprint that identifies something and one that identifies a
 * browser build, and an operator raising it to "catch more" would be buying
 * a queue of innocents.
 */
const MAX_ACCOUNTS_PER_SIGNAL = 6;

/**
 * How many DISTINCT values of one kind a single account may put on file.
 *
 * Fifty. A person's real devices are counted in single figures; fifty is far
 * above any honest browser history and far below a number that costs anything
 * to store. Past it the account keeps refreshing the signals it already
 * reported and stops adding new ones, so the evidence it has already given is
 * never lost — only the endless tail is.
 */
const MAX_SIGNALS_PER_ACCOUNT = 50;

@Injectable()
export class DeviceIntelligenceService {
  private readonly logger = new Logger(DeviceIntelligenceService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    /**
     * Optional so the service constructs without the blocklist module. Absent,
     * the second of the two match sources goes quiet — matches against a LIVE
     * blocked account still fire, so the feature degrades rather than fails.
     */
    @Optional() private readonly blockedIdentityService?: BlockedIdentityService,
  ) {}

  /**
   * Records what the cabinet reported and, if it belongs to a banned machine,
   * marks the account.
   *
   * NEVER THROWS AT THE CALLER. This runs beside a page load, and a device
   * report that fails must not be the thing that stops somebody using their
   * subscription. A failure here loses a signal; a failure that propagates
   * loses the customer.
   */
  public async report(input: {
    readonly userId: string;
    readonly installId?: string | null;
    readonly deviceHash?: string | null;
  }): Promise<void> {
    const signals = [
      normaliseDeviceSignal(DeviceSignalKind.INSTALL_ID, input.installId),
      normaliseDeviceSignal(DeviceSignalKind.DEVICE_HASH, input.deviceHash),
    ].filter((signal): signal is Extract<typeof signal, { ok: true }> => signal.ok);
    if (signals.length === 0) return;

    try {
      for (const signal of signals) {
        await this.record(input.userId, signal.kind, signal.value);
        await this.evaluate(input.userId, signal.kind, signal.value);
      }
    } catch (err) {
      this.logger.warn(`Device report failed for ${input.userId}: ${(err as Error).message}`);
    }
  }

  /**
   * Open flags for a page of users, as `userId → count`.
   *
   * ONE QUERY FOR THE WHOLE PAGE. The users list renders fifty rows; a
   * per-row lookup would be fifty round-trips on the busiest admin screen
   * there is.
   */
  public async openFlagCounts(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    if (userIds.length === 0) return counts;
    const grouped = await this.prismaService.userReviewFlag.groupBy({
      by: ['userId'],
      where: { userId: { in: [...userIds] }, clearedAt: null },
      _count: { _all: true },
    });
    for (const row of grouped) counts.set(row.userId, row._count._all);
    return counts;
  }

  /** Every flag on one account, newest first — cleared ones included. */
  public async listForUser(userId: string): Promise<readonly UserReviewFlagView[]> {
    const rows = await this.prismaService.userReviewFlag.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      relatedUserId: row.relatedUserId,
      detail: (row.detail ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
      clearedAt: row.clearedAt?.toISOString() ?? null,
      clearedById: row.clearedById,
    }));
  }

  /**
   * Marks a flag judged.
   *
   * The row stays. "Was this account ever flagged, and what did we decide" is
   * the question that actually gets asked, and a queue that deletes what it
   * resolves cannot answer it.
   */
  public async clear(
    flagId: string,
    adminId: string | null,
    /**
     * The account the caller believes the flag belongs to. Required, because
     * the caller reaches this method through a per-user route and the audit row
     * it writes names THAT user.
     */
    userId: string,
  ): Promise<boolean> {
    // SCOPED TO THE OWNER. Without the `userId` term any admin holding a flag
    // id could clear a flag on an account they were not looking at, and the
    // audit row — written by the controller from the id in the URL — would name
    // the untouched account instead. The flag would vanish from the real one
    // with no record at all.
    const outcome = await this.prismaService.userReviewFlag.updateMany({
      where: { id: flagId, userId, clearedAt: null },
      data: { clearedAt: new Date(), clearedById: adminId },
    });
    // Answered rather than silent, so the caller can tell "cleared" from "that
    // flag is not on this account" and refuse instead of writing a false trail.
    return outcome.count > 0;
  }

  /**
   * The device signals an account has reported — used by the block cascade to
   * copy them onto the blocklist, so the evidence outlives the account.
   */
  public async valuesForUser(userId: string): Promise<readonly string[]> {
    const rows = await this.prismaService.deviceObservation.findMany({
      where: { userId },
      select: { value: true },
      // ORDERED, and the ordering is the whole point of the cap being safe.
      //
      // An unordered `take: 100` hands Postgres' choice of a hundred rows to a
      // ban that is about to be the only surviving record: observations
      // cascade-delete with the account, and deleting a banned account is
      // frequently the next thing an operator does. An account that had posted
      // ten thousand junk install ids — nothing stops it doing so — would see
      // its real fingerprint copied with about one chance in a hundred, and the
      // evidence this whole feature exists to preserve would go with the row.
      //
      // `hits` then `lastSeenAt` is the right order because it is the same
      // question an operator asks of a match: a machine used daily outranks one
      // touched once, and junk minted in a burst is touched once by
      // construction.
      orderBy: [{ hits: 'desc' }, { lastSeenAt: 'desc' }],
      take: 100,
    });
    return rows.map((row) => row.value);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async record(
    userId: string,
    kind: DeviceSignalKind,
    value: string,
  ): Promise<void> {
    // Update first, and return if it landed. `hits` and `lastSeenAt` are what
    // separate a machine somebody uses daily from one they touched once; an
    // operator needs that before acting on a match, and a bare existence row
    // cannot say it. A signal already on file is always welcome however many
    // there are — the cap below is about NEW ones.
    const updated = await this.prismaService.deviceObservation.updateMany({
      where: { userId, kind, value },
      data: { lastSeenAt: new Date(), hits: { increment: 1 } },
    });
    if (updated.count > 0) return;

    // ── A NEW VALUE IS CAPPED PER ACCOUNT ─────────────────────────────────
    //
    // This used to be a bare upsert, so the row count was bounded by nothing.
    // The endpoint takes the signal from the request body, the unique index
    // dedupes only identical values, and the only rate limit in front of it is
    // a generic per-IP one shared with the rest of the API — so a script with a
    // valid session could mint a fresh install id per request and write rows
    // until the disk complained.
    //
    // It also happens without an attacker: Brave farbles its canvas per
    // session, so every browsing session yields a new `deviceHash` and one more
    // permanent row, forever.
    //
    // Past the cap the account keeps refreshing what it already reported and
    // stops adding. An account with this many distinct devices is not one this
    // feature can say anything useful about anyway.
    const held = await this.prismaService.deviceObservation.count({
      where: { userId, kind },
    });
    if (held >= MAX_SIGNALS_PER_ACCOUNT) {
      this.logger.warn(
        `Account ${userId} already holds ${held} distinct ${kind} signals; the new one was ` +
          'not recorded. Either a browser that re-randomises this value every session, or ' +
          'somebody writing rows on purpose.',
      );
      return;
    }
    try {
      await this.prismaService.deviceObservation.create({ data: { userId, kind, value } });
    } catch {
      // The unique index racing another request for the same value. Both
      // wanted the row to exist and it does, so there is nothing to report.
    }
  }

  /**
   * Two independent ways a signal can be known-bad, and both are needed.
   *
   * A LIVE BLOCKED ACCOUNT that reported the same signal. This is the useful
   * one for an operator, because it names the account to compare against.
   *
   * A BLOCKLIST ENTRY for the value. Observations cascade-delete with the user,
   * so deleting a banned account — frequently the first thing done after a ban
   * — would erase the first source entirely. The blocklist copy is written by
   * the block cascade for exactly that reason.
   */
  private async evaluate(
    userId: string,
    kind: DeviceSignalKind,
    value: string,
  ): Promise<void> {
    // ── A VALUE A CROWD REPORTS IS NOT A DEVICE ───────────────────────────
    //
    // The browser digest is computed from WebGL, canvas, audio and hardware
    // hints, and there are whole populations for which every one of those is a
    // constant: Tor Browser and Firefox with `privacy.resistFingerprinting`
    // spoof them by design, and Apple Silicon Safari reports the same generic
    // GPU string for every machine. Those users do not get a weak fingerprint —
    // they get an IDENTICAL one, shared with everybody like them.
    //
    // Without this guard, one blocked user from such a population marks every
    // other member of it on their next page load: an amber badge on thousands
    // of innocent accounts, all pointing at the same "related" stranger. That
    // is worse than no signal, because a queue full of false marks is one an
    // operator stops reading, and the true matches go with it.
    //
    // So: count the distinct accounts that have ever reported this value, and
    // treat anything above the ceiling as a browser class rather than a
    // machine. A real device shared by more than a handful of paying accounts
    // is already indistinguishable from a constant.
    const sharedBy = await this.prismaService.deviceObservation.groupBy({
      by: ['userId'],
      where: { kind, value },
      _count: { _all: true },
    });
    if (sharedBy.length > MAX_ACCOUNTS_PER_SIGNAL) {
      // Logged once per evaluation rather than silently dropped: an operator
      // asking "why is this obvious duplicate not flagged" has to be able to
      // find the answer, and a client build that reports one constant for
      // everybody is a fact worth acting on in itself.
      this.logger.warn(
        `Device signal seen on ${sharedBy.length} accounts — treated as a browser class, ` +
          'not a device, and no flag was raised. A digest that many accounts share is a ' +
          'privacy-hardened or spoofing browser, not a machine somebody is lending out.',
      );
      return;
    }

    const sibling = await this.prismaService.deviceObservation.findFirst({
      where: { kind, value, userId: { not: userId }, user: { isBlocked: true } },
      select: { userId: true },
      orderBy: { lastSeenAt: 'desc' },
    });

    const listed =
      sibling === null
        ? await this.blockedIdentityService?.find(BlockedIdentityKind.DEVICE_FP, value)
        : null;

    if (sibling === null && (listed === null || listed === undefined)) return;

    await this.raiseFlag({
      userId,
      kind,
      value,
      relatedUserId: sibling?.userId ?? null,
      source: sibling !== null ? 'blocked_account' : 'blocklist_entry',
    });
  }

  private async raiseFlag(input: {
    readonly userId: string;
    readonly kind: DeviceSignalKind;
    readonly value: string;
    readonly relatedUserId: string | null;
    readonly source: 'blocked_account' | 'blocklist_entry';
  }): Promise<void> {
    const fingerprint = deviceFlagFingerprint(input.kind, input.value);
    const detail: Prisma.InputJsonObject = {
      signal: input.kind,
      source: input.source,
      // The VALUE is deliberately absent. An operator cannot act on an opaque
      // digest, and putting it in a JSON column that admin screens render would
      // spread a tracking identifier across the UI for no gain.
      strength: input.kind === DeviceSignalKind.DEVICE_HASH ? 'lead' : 'strong',
    };

    await this.prismaService.userReviewFlag.upsert({
      where: {
        userId_kind_fingerprint: {
          userId: input.userId,
          kind: UserReviewFlagKind.DEVICE_MATCH,
          fingerprint,
        },
      },
      create: {
        userId: input.userId,
        kind: UserReviewFlagKind.DEVICE_MATCH,
        fingerprint,
        relatedUserId: input.relatedUserId,
        detail,
      },
      // A repeat sighting refreshes the evidence but must NOT reopen a flag an
      // operator has already judged: the device does not stop matching just
      // because the decision was "this is a household", and reopening it would
      // hand them the same row to dismiss on every page load.
      update: { relatedUserId: input.relatedUserId, detail },
    });

    this.logger.log(
      `Device match on user ${input.userId} (${input.kind}, source=${input.source})`,
    );
  }
}

export interface UserReviewFlagView {
  readonly id: string;
  readonly kind: UserReviewFlagKind;
  readonly relatedUserId: string | null;
  readonly detail: Record<string, unknown>;
  readonly createdAt: string;
  readonly clearedAt: string | null;
  readonly clearedById: string | null;
}
