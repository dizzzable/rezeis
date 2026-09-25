import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SubscriptionStatus, SyncJobStatus } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { describeStrictOutcome } from '../remnawave/interfaces/remnawave-strict-outcome.interface';
import { isNumericPanelIdentity } from '../remnawave/services/panel-user-address';
import {
  RemnawaveApiService,
  type RemnawavePanelUser,
} from '../remnawave/services/remnawave-api.service';
import {
  readProfileOwnerMarker,
  readProfileSubscriptionMarkers,
  subscriptionMarkerAllows,
} from './panel-owner-marker';

/** How many ids one `IN` list carries. Bounds a statement, not the comparison. */
const COMPARISON_BATCH = 1000;

/**
 * How many customers one comparison keeps for the operator's list. Normally a
 * handful have an extra profile; the cap only stops a pathological panel from
 * making the stored result unboundedly large, and says so (`truncated`).
 */
export const PANEL_PROFILE_COMPARISON_MAX_CUSTOMERS = 500;

/**
 * How many owners that are NOT users of this install one comparison keeps, in
 * their own list beside the customers' (review R3b-03). Small on purpose: a
 * Remnawave shared with another install can name thousands of its customers,
 * and nothing here can be linked; the count of all of them is kept
 * (`unknownOwnersTotal`).
 */
export const PANEL_PROFILE_COMPARISON_MAX_UNKNOWN_OWNERS = 50;

/**
 * The audit action every deletion of a user by an operator writes, with the
 * user's id in `metadata.userId` — the user card's «Удалить» and «Удалить
 * полностью» (`admin-user-management.controller.ts`) and the bulk toolbar
 * (`bulk-user-operations.service.ts`) alike.
 */
const USER_DELETED_AUDIT_ACTION = 'user.deleted';

/**
 * What the automatic link did with one extra profile — the codes the list in
 * «Подписки» → «Инструменты» → «Лишние профили в Remnawave» translates.
 */
export type AutoLinkOutcome =
  /** Linked to {@link ComparedProfile.autoLinkedSubscriptionId}. */
  | 'linked'
  /** The customer has no live subscription with an empty or non-decimal link. */
  | 'noSubscriptionWithoutLink'
  /** More than one such subscription: which one is the operator's call. */
  | 'severalSubscriptions'
  /** More than one extra profile for this customer: which one is the operator's call. */
  | 'severalProfiles'
  /** The profile's `subscription_id` line names a subscription other than the one candidate. */
  | 'subscriptionMarkerMismatch'
  /** The one candidate records ANOTHER profile's numeric id (`remnawave_panel_id`). */
  | 'subscriptionRecordsAnotherProfile'
  /** A live subscription of ANOTHER customer links this profile. */
  | 'takenByOtherRow'
  /**
   * A DELETED subscription still names this profile (its deletion kept or has
   * not yet removed the profile): it is that subscription's, not a free one.
   */
  | 'namedByDeletedSubscription'
  /** The candidate has a profile sync job queued or running: the job decides first. */
  | 'syncInFlight'
  /** The subscription or the profile changed while the check ran. */
  | 'changedDuringCheck'
  /** Not attempted: Remnawave's list was not read whole. */
  | 'panelUnavailable'
  /**
   * Never attempted: the `reiwa_id` line names nobody this install has — a
   * customer deleted here, or another install's (`unknownOwners`).
   */
  | 'ownerNotInPanel';

export interface ComparedProfile {
  /** The profile's numeric id in decimal — the identity a link stores. */
  readonly profileId: string;
  readonly username: string;
  /** Remnawave's own status: ACTIVE, DISABLED, LIMITED, EXPIRED. */
  readonly status: string | null;
  readonly createdAt: string | null;
  readonly usedTrafficBytes: number | null;
  /** The profile's first `subscription_id` line, when it has one. */
  readonly subscriptionMarker: string | null;
  /**
   * The subscription that names it, as the comparison found it: a live one of
   * ANOTHER customer (`takenByOtherRow`), or a DELETED one
   * (`namedByDeletedSubscription`).
   */
  readonly linkedBySubscriptionId: string | null;
  readonly autoLink: AutoLinkOutcome;
  readonly autoLinkedSubscriptionId: string | null;
  readonly autoLinkedAt: string | null;
}

export interface ComparedCustomer {
  /** The `reiwa_id` the profiles name. */
  readonly userId: string;
  readonly profiles: readonly ComparedProfile[];
}

/**
 * Extra profiles whose `reiwa_id` line names a user this install does NOT
 * have (review R3b-03): a customer deleted here — a deletion removes the
 * profile from Remnawave only best-effort (`UserDeletionService`) — or another
 * install's customer on a shared Remnawave. Nothing can be linked to them.
 */
export interface ComparedUnknownOwner {
  /** The `reiwa_id` the profiles name. */
  readonly userId: string;
  /**
   * When an operator deleted that user here, by the audit row the deletion
   * wrote ({@link USER_DELETED_AUDIT_ACTION}); `null` when there is none. So a
   * date proves a deletion, and `null` proves nothing: the audit keeps
   * `AUDIT_RETENTION_DAYS` (90 by default), a user an account merge or the
   * cabinet removed writes no such row, and another install's customer never
   * had one.
   */
  readonly deletedAt: string | null;
  readonly profiles: readonly ComparedProfile[];
}

/** One link the comparison wrote, for the run's audit row: enough to undo it by hand. */
export interface ComparisonLink {
  readonly subscriptionId: string;
  readonly userId: string;
  /** What the row held before — `null` or the non-decimal value. */
  readonly previousRemnawaveId: string | null;
  readonly previousPanelId: number | null;
  readonly remnawaveId: string;
  readonly panelId: number;
  readonly panelUsername: string;
  /** Always the owner line; plus the subscription line when the profile had one. */
  readonly proof: 'reiwa_id' | 'reiwa_id+subscription_id';
}

export interface PanelProfileComparison {
  readonly comparedAt: string;
  /** `partial`: Remnawave's list stopped at the read ceiling, so nothing was linked. */
  readonly readOutcome: 'complete' | 'partial';
  readonly profilesRead: number;
  /** Profiles with no single `reiwa_id` line (or no numeric id): not compared, not listed. */
  readonly profilesWithoutOwner: number;
  readonly autoLinked: number;
  /** Customers with an extra profile — including the ones linked by this run. */
  readonly customers: readonly ComparedCustomer[];
  readonly truncated: boolean;
  /**
   * Owners this install does not have, apart from the customers and never in
   * their places: those deleted here first (newest deletion first), then the
   * rest by id, at most {@link PANEL_PROFILE_COMPARISON_MAX_UNKNOWN_OWNERS}.
   */
  readonly unknownOwners: readonly ComparedUnknownOwner[];
  /** How many such owners had an extra profile, whatever the cap kept. */
  readonly unknownOwnersTotal: number;
  readonly links: readonly ComparisonLink[];
}

export type PanelProfileComparisonOutcome =
  | { readonly kind: 'ok'; readonly result: PanelProfileComparison }
  /** The list could not be read; nothing was compared or written. */
  | { readonly kind: 'unavailable'; readonly detail: string };

/** One owned profile, as the comparison needs it. */
interface OwnedProfile {
  readonly panelId: number;
  readonly username: string;
  readonly status: string | null;
  readonly createdAt: string | null;
  readonly usedTrafficBytes: number | null;
  readonly description: string | null;
  readonly subscriptionUrl: string | null;
}

/** A live subscription, as the comparison reads it. */
interface LiveRow {
  readonly id: string;
  readonly userId: string;
  readonly remnawaveId: string | null;
  readonly remnawavePanelId: number | null;
}

/** A link is empty or names nobody a supported panel answers to. */
function lacksLink(row: { readonly remnawaveId: string | null }): boolean {
  return row.remnawaveId === null || !isNumericPanelIdentity(row.remnawaveId);
}

/** The profile's numeric id: the decoded `panelId`, else a decimal identity string. */
function panelIdOf(user: RemnawavePanelUser): number | null {
  if (typeof user.panelId === 'number' && Number.isSafeInteger(user.panelId) && user.panelId > 0) {
    return user.panelId;
  }
  if (typeof user.uuid === 'string' && isNumericPanelIdentity(user.uuid)) {
    const parsed = Number(user.uuid);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** Owner ids in code-unit order: the same order on every run and every process. */
function byOwnerId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** What the list says of one extra profile, before the automatic link's verdict. */
function describeExtraProfile(
  profile: OwnedProfile,
  linkedBySubscriptionId: string | null,
): Omit<ComparedProfile, 'autoLink'> {
  return {
    profileId: String(profile.panelId),
    username: profile.username,
    status: profile.status,
    createdAt: profile.createdAt,
    usedTrafficBytes: profile.usedTrafficBytes,
    subscriptionMarker: readProfileSubscriptionMarkers(profile.description)[0] ?? null,
    linkedBySubscriptionId,
    autoLinkedSubscriptionId: null,
    autoLinkedAt: null,
  };
}

/**
 * PanelProfileComparisonService
 * ─────────────────────────────
 * The per-customer comparison (owner's decision, 24.09.2026): every Remnawave
 * profile whose `reiwa_id` line names a customer of THIS install, set against
 * that customer's live subscriptions. A profile none of their live
 * subscriptions links is an EXTRA profile, listed in «Подписки» →
 * «Инструменты» → «Лишние профили в Remnawave». A line naming a user this
 * install does not have — a customer deleted here, whose profile the deletion
 * removed only best-effort, or another install's on a shared Remnawave — is
 * listed APART (`unknownOwners`, review R3b-03): never linked, and never in a
 * customer's place under the cap.
 *
 * ONE AUTOMATIC LINK, AND ONLY WHEN NOTHING IS AMBIGUOUS. When a customer has
 * exactly one live subscription whose link is empty or not a decimal AND exactly
 * one extra profile that NO live row links, that profile is linked to that
 * subscription:
 *   • the ownership proof is the profile's `reiwa_id` line — every line naming
 *     this customer (`readProfileOwnerMarker`), the proof the CREATE path adopts
 *     by;
 *   • the profile's `subscription_id` line, when it has one, must name this
 *     subscription (`subscription_id` narrows, it never proves);
 *   • the candidate must not record another profile's numeric id, and must not
 *     have a sync job queued or running — a CREATE in flight decides first;
 *   • no DELETED subscription may still name the profile: with profile deletion
 *     switched off (or its DELETE not done yet) that profile is the deleted
 *     subscription's, and handing it to a new one would give the customer an
 *     old profile — listed as `namedByDeletedSubscription` instead;
 *   • the write takes the same profile advisory lock `persistProfileLink` and
 *     the panel-link walk take, asks the same two-angled collision question
 *     under it (no other live row may name the profile by either identifier),
 *     and fences on what the row held when it was read.
 * Two subscriptions and one profile, one subscription and two profiles, a
 * profile another customer's row links: listed, never guessed at.
 *
 * NOTHING IS EVER DELETED — not in Remnawave, not in our database — and nothing
 * is pushed. The only write is the LINK columns of the one subscription. The
 * owner's worry, verbatim: «мы не удалим случайно чужую подписку».
 *
 * BOUNDED. The whole list comes from `strictGetAllPanelUsers` — the keyset walk
 * over `/api/users/stream`, 500 rows a page, 50 pages at most — and a list that
 * stopped at that ceiling is compared but links nothing (a second extra profile
 * past the ceiling would make the "exactly one" untrue). Database reads go in
 * batches of {@link COMPARISON_BATCH}.
 */
@Injectable()
export class PanelProfileComparisonService {
  private readonly logger = new Logger(PanelProfileComparisonService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApi: RemnawaveApiService,
  ) {}

  public async compare(now: Date = new Date()): Promise<PanelProfileComparisonOutcome> {
    const read = await this.remnawaveApi.strictGetAllPanelUsers();
    if (read.kind !== 'ok') {
      return { kind: 'unavailable', detail: describeStrictOutcome(read) };
    }
    const { users, complete } = read.value;

    // ── 1. Every profile that names an owner, by owner ────────────────────
    const byOwner = new Map<string, OwnedProfile[]>();
    let withoutOwner = 0;
    for (const user of users) {
      const panelId = panelIdOf(user);
      const owner = readProfileOwnerMarker(user.description);
      if (panelId === null || owner === null) {
        withoutOwner += 1;
        continue;
      }
      const profiles = byOwner.get(owner) ?? [];
      profiles.push({
        panelId,
        username: typeof user.username === 'string' ? user.username : '',
        status: typeof user.status === 'string' ? user.status : null,
        createdAt: typeof user.createdAt === 'string' ? user.createdAt : null,
        usedTrafficBytes: user.userTraffic?.usedTrafficBytes ?? null,
        description: typeof user.description === 'string' ? user.description : null,
        subscriptionUrl:
          typeof user.subscriptionUrl === 'string' && user.subscriptionUrl.length > 0
            ? user.subscriptionUrl
            : null,
      });
      byOwner.set(owner, profiles);
    }

    // ── 2. Which live rows link each of those profiles ────────────────────
    //
    // BY EITHER IDENTIFIER, the question every exclusivity check asks: a row
    // names a profile by the decimal in `remnawave_id` or by
    // `remnawave_panel_id`. A row still holding a 2.x uuid with the numeric id
    // beside it LINKS the profile for this purpose — the walk is what rewrites
    // its spelling.
    const ownedPanelIds = [...byOwner.values()].flatMap((profiles) => profiles.map((profile) => profile.panelId));
    const linkers = await this.readLinkers(ownedPanelIds);
    // A DELETED row that still names a profile — profile deletion switched off,
    // or its DELETE not done yet — makes that profile the deleted
    // subscription's: listed, never given to another subscription.
    const deletedNamers = await this.readDeletedNamers(ownedPanelIds);

    // ── 3. The customers with an extra profile ─────────────────────────────
    //
    // THIS INSTALL'S CUSTOMERS, ASKED BEFORE THE CAP. A Remnawave shared with
    // another install carries that install's `reiwa_id` lines for users that
    // exist nowhere here; sorted and cut first, they could fill all
    // {@link PANEL_PROFILE_COMPARISON_MAX_CUSTOMERS} places, and this install's
    // own customers were then never compared, listed or linked (R2b-04). A
    // customer of this install with no live subscription stays: their profiles
    // are extra all the same. Owners this install does not have are kept APART
    // (step 5), under a cap of their own.
    const withExtra = [...byOwner.entries()].filter(([owner, profiles]) =>
      profiles.some(
        (profile) => !(linkers.get(profile.panelId) ?? []).some((row) => row.userId === owner),
      ),
    );
    const localUsers = await this.readLocalUsers(withExtra.map(([owner]) => owner));
    const candidates = withExtra
      .filter(([owner]) => localUsers.has(owner))
      .sort(([left], [right]) => byOwnerId(left, right));
    const truncated = candidates.length > PANEL_PROFILE_COMPARISON_MAX_CUSTOMERS;
    const kept = candidates.slice(0, PANEL_PROFILE_COMPARISON_MAX_CUSTOMERS);
    const ownerIds = kept.map(([owner]) => owner);

    const withoutLink = new Map<string, LiveRow[]>();
    for (const batch of chunks(ownerIds, COMPARISON_BATCH)) {
      const rows = await this.prismaService.subscription.findMany({
        where: { userId: { in: batch }, status: { not: SubscriptionStatus.DELETED } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, userId: true, remnawaveId: true, remnawavePanelId: true },
      });
      for (const row of rows) {
        if (!lacksLink(row)) continue;
        const list = withoutLink.get(row.userId) ?? [];
        list.push(row);
        withoutLink.set(row.userId, list);
      }
    }
    const inFlight = await this.readSyncInFlight(
      [...withoutLink.values()].flatMap((rows) => rows.map((row) => row.id)),
    );

    // ── 4. Decide, customer by customer ────────────────────────────────────
    const customers: ComparedCustomer[] = [];
    const links: ComparisonLink[] = [];
    for (const [owner, profiles] of kept) {
      const extra = profiles.filter(
        (profile) => !(linkers.get(profile.panelId) ?? []).some((row) => row.userId === owner),
      );
      const free = extra.filter(
        (profile) => (linkers.get(profile.panelId) ?? []).length === 0 && !deletedNamers.has(profile.panelId),
      );
      const rows = withoutLink.get(owner) ?? [];
      const compared: ComparedProfile[] = [];
      for (const profile of extra) {
        const holder = (linkers.get(profile.panelId) ?? []).find((row) => row.userId !== owner) ?? null;
        const deleted = deletedNamers.get(profile.panelId) ?? null;
        const base = describeExtraProfile(profile, holder?.id ?? deleted);
        if (holder !== null) {
          compared.push({ ...base, autoLink: 'takenByOtherRow' });
          continue;
        }
        if (deleted !== null) {
          compared.push({ ...base, autoLink: 'namedByDeletedSubscription' });
          continue;
        }
        const verdict = await this.decide(owner, profile, free, rows, inFlight, complete);
        if (verdict.link !== null) links.push(verdict.link);
        compared.push({
          ...base,
          autoLink: verdict.outcome,
          autoLinkedSubscriptionId: verdict.link?.subscriptionId ?? null,
          autoLinkedAt: verdict.link === null ? null : now.toISOString(),
        });
      }
      customers.push({ userId: owner, profiles: compared });
    }

    // ── 5. The owners this install does not have ──────────────────────────
    //
    // Listed, never linked: there is no customer here to link a profile to.
    // Their own place and their own cap, so they can never again take this
    // install's customers' places (R2b-04), nor vanish altogether (R3b-03) —
    // the profile of a customer deleted here stays live whenever the
    // deletion's best-effort removal from Remnawave failed, and this list is
    // then the only place an operator sees it. Those the audit shows deleted
    // here come first, newest first: they are this install's to clear up;
    // another install's never are.
    const unknown = withExtra.filter(([owner]) => !localUsers.has(owner));
    const deletions = await this.readDeletions(unknown.map(([owner]) => owner));
    const unknownOwners: ComparedUnknownOwner[] = unknown
      .sort(([left], [right]) => {
        const leftAt = deletions.get(left)?.getTime() ?? null;
        const rightAt = deletions.get(right)?.getTime() ?? null;
        if (leftAt !== rightAt) {
          if (leftAt === null) return 1;
          if (rightAt === null) return -1;
          return rightAt - leftAt;
        }
        return byOwnerId(left, right);
      })
      .slice(0, PANEL_PROFILE_COMPARISON_MAX_UNKNOWN_OWNERS)
      .map(([owner, profiles]) => ({
        userId: owner,
        deletedAt: deletions.get(owner)?.toISOString() ?? null,
        profiles: profiles.map((profile): ComparedProfile => {
          // Named by a live row (someone else's — nobody is this owner) or by a
          // DELETED one: said as for a customer. Otherwise nobody here has it.
          const holder = (linkers.get(profile.panelId) ?? [])[0] ?? null;
          const deleted = deletedNamers.get(profile.panelId) ?? null;
          return {
            ...describeExtraProfile(profile, holder?.id ?? deleted),
            autoLink:
              holder !== null ? 'takenByOtherRow' : deleted !== null ? 'namedByDeletedSubscription' : 'ownerNotInPanel',
          };
        }),
      }));

    if (links.length > 0) {
      this.logger.log(
        `Remnawave profile comparison linked ${links.length} subscription(s) to their customer's ` +
          `one extra profile: ${links.map((link) => `${link.subscriptionId}→${link.remnawaveId}`).join(', ')}`,
      );
    }
    return {
      kind: 'ok',
      result: {
        comparedAt: now.toISOString(),
        readOutcome: complete ? 'complete' : 'partial',
        profilesRead: users.length,
        profilesWithoutOwner: withoutOwner,
        autoLinked: links.length,
        customers,
        truncated,
        unknownOwners,
        unknownOwnersTotal: unknown.length,
        links,
      },
    };
  }

  /**
   * The automatic link's rule for ONE extra profile of `owner` that no live row
   * links. Every refusal is a named outcome; only the last branch writes.
   */
  private async decide(
    owner: string,
    profile: OwnedProfile,
    free: readonly OwnedProfile[],
    rows: readonly LiveRow[],
    inFlight: ReadonlySet<string>,
    complete: boolean,
  ): Promise<{ readonly outcome: AutoLinkOutcome; readonly link: ComparisonLink | null }> {
    if (!complete) return { outcome: 'panelUnavailable', link: null };
    if (free.length > 1) return { outcome: 'severalProfiles', link: null };
    if (rows.length === 0) return { outcome: 'noSubscriptionWithoutLink', link: null };
    if (rows.length > 1) return { outcome: 'severalSubscriptions', link: null };
    const [candidate] = rows;
    if (candidate.remnawavePanelId !== null && candidate.remnawavePanelId !== profile.panelId) {
      return { outcome: 'subscriptionRecordsAnotherProfile', link: null };
    }
    if (!subscriptionMarkerAllows(profile.description, candidate.id)) {
      return { outcome: 'subscriptionMarkerMismatch', link: null };
    }
    const named = readProfileSubscriptionMarkers(profile.description);
    if (inFlight.has(candidate.id)) return { outcome: 'syncInFlight', link: null };
    const outcome = await this.writeLink(owner, candidate, profile);
    if (outcome !== 'linked') return { outcome, link: null };
    return {
      outcome: 'linked',
      link: {
        subscriptionId: candidate.id,
        userId: owner,
        previousRemnawaveId: candidate.remnawaveId,
        previousPanelId: candidate.remnawavePanelId,
        remnawaveId: String(profile.panelId),
        panelId: profile.panelId,
        panelUsername: profile.username,
        proof: named.length > 0 ? 'reiwa_id+subscription_id' : 'reiwa_id',
      },
    };
  }

  /**
   * The link, under the same mutual exclusion `persistProfileLink` and the
   * panel-link walk take: the profile advisory lock, then the two-angled
   * collision question, then a compare-and-swap on what the row held when the
   * comparison read it (still this customer's, still live, still the same
   * link). A concurrent CREATE or link wins; this reports `changedDuringCheck`.
   */
  private async writeLink(
    owner: string,
    candidate: LiveRow,
    profile: OwnedProfile,
  ): Promise<'linked' | 'takenByOtherRow' | 'changedDuringCheck'> {
    const remnawaveId = String(profile.panelId);
    return this.prismaService.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${`remnawave-profile:${remnawaveId}`})::bigint)
      `);
      const holders = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "subscriptions"
        WHERE "id" <> ${candidate.id}
          AND "status" <> 'DELETED'
          AND ("remnawave_id" = ${remnawaveId} OR "remnawave_panel_id" = ${profile.panelId}::int)
        LIMIT 1
      `);
      if (holders.length > 0) return 'takenByOtherRow';
      const written = await tx.subscription.updateMany({
        where: {
          id: candidate.id,
          userId: owner,
          status: { not: SubscriptionStatus.DELETED },
          remnawaveId: candidate.remnawaveId,
          remnawavePanelId: candidate.remnawavePanelId,
        },
        data: {
          remnawaveId,
          remnawavePanelId: profile.panelId,
          // The profile's own name and link, as the manual «Привязать профиль»
          // records them: a row that was never provisioned has neither, and the
          // cabinet shows the customer the config URL.
          ...(profile.username.length > 0 ? { remnawavePanelUsername: profile.username } : {}),
          ...(profile.subscriptionUrl !== null ? { configUrl: profile.subscriptionUrl } : {}),
          // Linked: nothing is left for a CREATE to look for under the name its
          // last attempt recorded.
          remnawavePendingUsername: null,
          remnawavePendingOwnerId: null,
        },
      });
      return written.count === 1 ? 'linked' : 'changedDuringCheck';
    });
  }

  /**
   * When an operator last deleted each of `userIds` here, as the audit row of
   * the deletion says ({@link USER_DELETED_AUDIT_ACTION}, `metadata.userId`).
   * A hint, not a verdict: see {@link ComparedUnknownOwner.deletedAt} for what
   * its absence does not prove.
   */
  private async readDeletions(userIds: readonly string[]): Promise<Map<string, Date>> {
    const deletedAt = new Map<string, Date>();
    for (const batch of chunks(userIds, COMPARISON_BATCH)) {
      const rows = await this.prismaService.$queryRaw<Array<{ userId: string; deletedAt: Date }>>(Prisma.sql`
        SELECT "metadata" ->> 'userId' AS "userId", max("created_at") AS "deletedAt"
          FROM "admin_audit_log"
         WHERE "action" = ${USER_DELETED_AUDIT_ACTION}
           AND "metadata" ->> 'userId' = ANY(${[...batch]}::text[])
         GROUP BY "metadata" ->> 'userId'
      `);
      for (const row of rows) deletedAt.set(row.userId, row.deletedAt);
    }
    return deletedAt;
  }

  /** Which of `userIds` are users of this install. */
  private async readLocalUsers(userIds: readonly string[]): Promise<Set<string>> {
    const local = new Set<string>();
    for (const batch of chunks(userIds, COMPARISON_BATCH)) {
      const users = await this.prismaService.user.findMany({
        where: { id: { in: batch } },
        select: { id: true },
      });
      for (const user of users) local.add(user.id);
    }
    return local;
  }

  /** Every live row that names one of `panelIds`, by either identifier. */
  private async readLinkers(panelIds: readonly number[]): Promise<Map<number, LiveRow[]>> {
    const linkers = new Map<number, LiveRow[]>();
    const wanted = new Set(panelIds);
    for (const batch of chunks([...wanted], COMPARISON_BATCH)) {
      const rows = await this.prismaService.subscription.findMany({
        where: {
          status: { not: SubscriptionStatus.DELETED },
          OR: [
            { remnawaveId: { in: batch.map((panelId) => String(panelId)) } },
            { remnawavePanelId: { in: batch } },
          ],
        },
        select: { id: true, userId: true, remnawaveId: true, remnawavePanelId: true },
      });
      for (const row of rows) {
        const named = new Set<number>();
        if (row.remnawaveId !== null && isNumericPanelIdentity(row.remnawaveId)) {
          named.add(Number(row.remnawaveId));
        }
        if (row.remnawavePanelId !== null) named.add(row.remnawavePanelId);
        for (const panelId of named) {
          if (!wanted.has(panelId)) continue;
          const list = linkers.get(panelId) ?? [];
          list.push(row);
          linkers.set(panelId, list);
        }
      }
    }
    return linkers;
  }

  /** For each of `panelIds`, a DELETED row that still names it, by either identifier. */
  private async readDeletedNamers(panelIds: readonly number[]): Promise<Map<number, string>> {
    const namers = new Map<number, string>();
    const wanted = new Set(panelIds);
    for (const batch of chunks([...wanted], COMPARISON_BATCH)) {
      const rows = await this.prismaService.subscription.findMany({
        where: {
          status: SubscriptionStatus.DELETED,
          OR: [
            { remnawaveId: { in: batch.map((panelId) => String(panelId)) } },
            { remnawavePanelId: { in: batch } },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: { id: true, remnawaveId: true, remnawavePanelId: true },
      });
      for (const row of rows) {
        const named = new Set<number>();
        if (row.remnawaveId !== null && isNumericPanelIdentity(row.remnawaveId)) {
          named.add(Number(row.remnawaveId));
        }
        if (row.remnawavePanelId !== null) named.add(row.remnawavePanelId);
        for (const panelId of named) {
          if (wanted.has(panelId) && !namers.has(panelId)) namers.set(panelId, row.id);
        }
      }
    }
    return namers;
  }

  /** The subscriptions with a profile sync job PENDING or RUNNING. */
  private async readSyncInFlight(subscriptionIds: readonly string[]): Promise<Set<string>> {
    const inFlight = new Set<string>();
    for (const batch of chunks(subscriptionIds, COMPARISON_BATCH)) {
      const jobs = await this.prismaService.profileSyncJob.findMany({
        where: {
          subscriptionId: { in: batch },
          status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING] },
        },
        select: { subscriptionId: true },
      });
      for (const job of jobs) inFlight.add(job.subscriptionId);
    }
    return inFlight;
  }
}
