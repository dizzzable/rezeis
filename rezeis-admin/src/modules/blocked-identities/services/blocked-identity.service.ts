import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BlockedIdentity, BlockedIdentityKind, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  normaliseBlockedIdentity,
  telegramIdToBlockedValue,
} from '../utils/normalise-identity.util';

/**
 * Source of truth for the identity blocklist.
 *
 * ── Why this exists next to `users.is_blocked` ────────────────────────────
 *
 * That flag lives on a row, so it can only refuse somebody who has already
 * registered, and it is undone by registering again with a fresh Telegram
 * account. This table is keyed on the identity, so an entry can precede the
 * account and survive it.
 *
 * ── Why there is no cache, unlike `BlockedIpService` ──────────────────────
 *
 * The IP list is read by a guard on every request, so it pays for a 30-second
 * in-process cache. This one is read at registration, login and linking — a
 * handful of times per person, ever. A cache there would buy nothing and cost
 * the thing that matters most on a blocklist: an operator who adds an entry
 * expects it to bite on the next attempt, not within half a minute.
 *
 * ── Expiry is filtered, never deleted ────────────────────────────────────
 *
 * `expiresAt` in the past reads as "not blocked", but the row stays. A ban that
 * erases its own record leaves an operator unable to answer "was this person
 * ever blocked, and why" — which is the question that actually gets asked.
 */
@Injectable()
export class BlockedIdentityService {
  private readonly logger = new Logger(BlockedIdentityService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  // ── Read API ───────────────────────────────────────────────────────────

  /**
   * The live entry for an identity, or `null`.
   *
   * Takes the RAW value and normalises it here, so no caller can look up a
   * spelling the writer never stored. Every enforcement point goes through
   * this.
   */
  public async find(
    kind: BlockedIdentityKind,
    rawValue: string,
  ): Promise<BlockedIdentity | null> {
    const normalised = normaliseBlockedIdentity(kind, rawValue);
    if (!normalised.ok) return null;
    const entry = await this.prismaService.blockedIdentity.findUnique({
      where: { kind_value: { kind, value: normalised.value } },
    });
    if (entry === null) return null;
    return isLive(entry) ? entry : null;
  }

  /**
   * The first live entry among several identities — the shape every caller
   * actually needs, because a person arrives with a Telegram id AND possibly an
   * e-mail and a login, and any one of them being listed is a refusal.
   *
   * Entries with a `null`/empty value are skipped rather than treated as a
   * match: an anonymous web sign-up has no Telegram id, and looking one up
   * would be asking "is the empty identity blocked".
   */
  public async findFirstMatch(
    candidates: ReadonlyArray<{
      readonly kind: BlockedIdentityKind;
      readonly value: string | null | undefined;
    }>,
  ): Promise<BlockedIdentity | null> {
    const lookups: Prisma.BlockedIdentityWhereInput[] = [];
    for (const candidate of candidates) {
      if (typeof candidate.value !== 'string') continue;
      const normalised = normaliseBlockedIdentity(candidate.kind, candidate.value);
      if (!normalised.ok) continue;
      lookups.push({ kind: candidate.kind, value: normalised.value });
    }
    if (lookups.length === 0) return null;

    const now = new Date();
    return this.prismaService.blockedIdentity.findFirst({
      where: {
        OR: lookups,
        // Expired entries are invisible to enforcement but stay in the table.
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Convenience for the commonest question: is this Telegram id refused? */
  public async findByTelegramId(
    telegramId: bigint | number | null | undefined,
  ): Promise<BlockedIdentity | null> {
    const value = telegramIdToBlockedValue(telegramId);
    if (value === null) return null;
    return this.find(BlockedIdentityKind.TELEGRAM_ID, value);
  }

  public async list(input: {
    readonly kind?: BlockedIdentityKind;
    readonly search?: string;
  } = {}): Promise<readonly BlockedIdentity[]> {
    const search = (input.search ?? '').trim();
    return this.prismaService.blockedIdentity.findMany({
      where: {
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(search.length === 0
          ? {}
          : {
              OR: [
                { value: { contains: search, mode: 'insensitive' } },
                { reason: { contains: search, mode: 'insensitive' } },
              ],
            }),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  // ── Write API ──────────────────────────────────────────────────────────

  /**
   * Adds one or many identities in a single call.
   *
   * BULK IS THE DEFAULT SHAPE, not a convenience wrapper: the operator need
   * this exists for is "here is a list of ids to keep out", and a per-row
   * endpoint turns that into N requests with N chances to stop halfway.
   *
   * Rows are reported individually — added / promoted / already present /
   * rejected — because a paste of two hundred lines with three typos in it must
   * not fail as a unit. Refusing the whole list would teach operators to paste
   * smaller lists, not to fix the typos.
   *
   * ── `manual` and `cascade` are not two labels for one row ─────────────────
   *
   * They are two different powers. The guest support gate REFUSES on `manual`
   * and only MARKS on `cascade`, so a collision between them is not "already
   * there" — it is the caller asking for something the existing row does not do.
   *
   * That made the single most important call in the feature a no-op. An
   * operator silencing the device of somebody they had already blocked hit the
   * cascade rows the block itself had written, got them counted as duplicates,
   * and was told `silenced: 2` while both rows kept `source: 'cascade'` and the
   * device went on opening conversations for ever. Worse, unblocking that user
   * later deletes cascade rows, so the silence would have evaporated a second
   * time.
   *
   * So a `manual` write PROMOTES the row it collided with. The reverse never
   * happens: a cascade write leaves an existing row alone, because a ban must
   * not silently downgrade a decision a person made. An already-`manual` row is
   * also left alone — re-pasting a list that overlaps the previous one is
   * ordinary, and rewriting `reason`/`expiresAt` from it would quietly turn a
   * thirty-day entry somebody chose into a permanent one.
   */
  public async addMany(input: {
    readonly kind: BlockedIdentityKind;
    readonly values: readonly string[];
    readonly reason?: string | null;
    readonly expiresAt?: Date | null;
    readonly source?: string;
    readonly createdById?: string | null;
    /** For cascade rows: the user whose block produced them. */
    readonly originUserId?: string | null;
  }): Promise<{
    readonly added: readonly BlockedIdentity[];
    /** Existing `cascade` rows this manual write raised to `manual`. */
    readonly promoted: readonly BlockedIdentity[];
    readonly duplicates: readonly string[];
    readonly rejected: ReadonlyArray<{ readonly value: string; readonly reason: string }>;
  }> {
    const added: BlockedIdentity[] = [];
    const promoted: BlockedIdentity[] = [];
    const duplicates: string[] = [];
    const rejected: Array<{ value: string; reason: string }> = [];
    // Within one paste the same id can appear twice; the second occurrence is a
    // duplicate of the first, not of anything in the database.
    const seen = new Set<string>();

    for (const raw of input.values) {
      const normalised = normaliseBlockedIdentity(input.kind, raw);
      if (!normalised.ok) {
        rejected.push({ value: raw, reason: normalised.reason });
        continue;
      }
      if (seen.has(normalised.value)) {
        duplicates.push(normalised.value);
        continue;
      }
      seen.add(normalised.value);

      try {
        const entry = await this.prismaService.blockedIdentity.create({
          data: {
            kind: input.kind,
            value: normalised.value,
            reason: input.reason ?? null,
            source: input.source ?? 'manual',
            createdById: input.createdById ?? null,
            originUserId: input.originUserId ?? null,
            expiresAt: input.expiresAt ?? null,
          },
        });
        added.push(entry);
      } catch (err: unknown) {
        // P2002 is the unique index doing its job — the identity is already
        // listed. Reported as a duplicate rather than an error: re-pasting a
        // list that overlaps the previous one is normal operator behaviour and
        // must not look like a failure.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          // …but only when the row that is already there does what the caller
          // asked for. See the note on this method: a `manual` write landing on
          // a `cascade` row is the operator's silence colliding with the ban's
          // own mark, and calling that a duplicate left the device unsilenced.
          if ((input.source ?? 'manual') === 'manual') {
            const existing = await this.prismaService.blockedIdentity.findUnique({
              where: { kind_value: { kind: input.kind, value: normalised.value } },
              select: { id: true, source: true },
            });
            if (existing !== null && existing.source !== 'manual') {
              const entry = await this.prismaService.blockedIdentity.update({
                where: { id: existing.id },
                data: {
                  source: 'manual',
                  reason: input.reason ?? null,
                  createdById: input.createdById ?? null,
                  expiresAt: input.expiresAt ?? null,
                  // Cleared on purpose. `releaseCascadeForUser` finds rows by
                  // this column, and a promoted row must survive the unblock of
                  // the account that first produced it — the operator listed it
                  // by hand afterwards, and that decision is not undone by
                  // lifting the ban it happened to start from.
                  originUserId: null,
                },
              });
              promoted.push(entry);
              continue;
            }
          }
          duplicates.push(normalised.value);
          continue;
        }
        throw err;
      }
    }

    if (added.length > 0 || promoted.length > 0) {
      this.logger.log(
        `Blocklist: added ${added.length}, promoted ${promoted.length} ${input.kind} entries ` +
          `(source=${input.source ?? 'manual'})`,
      );
    }
    return { added, promoted, duplicates, rejected };
  }

  public async remove(id: string): Promise<void> {
    const existing = await this.prismaService.blockedIdentity.findUnique({ where: { id } });
    if (existing === null) throw new NotFoundException('Blocklist entry not found');
    await this.prismaService.blockedIdentity.delete({ where: { id } });
  }

  /**
   * Captures the identities of an existing user onto the blocklist.
   *
   * This is what makes blocking an account outlast the account. Called when an
   * operator blocks a user; `source: 'cascade'` plus `originUserId` keeps those
   * entries distinguishable from ones an operator typed, so removing a ban can
   * find exactly what that ban created and nothing else.
   *
   * ── Why device ids are captured here but never gate a sign-up ───────────
   *
   * A Telegram id, an e-mail and a login are things a person types at
   * registration, so listing them refuses the next attempt at the door. A
   * hardware id is not: it appears only once a VPN client connects, long after
   * the account exists. It is captured anyway because it is the one identifier
   * a ban evader carries across a new Telegram account and a new mailbox — the
   * enforcement for it necessarily runs after the fact.
   */
  public async captureFromUser(input: {
    readonly userId: string;
    readonly telegramId: bigint | null;
    readonly email: string | null;
    readonly webLogin: string | null;
    /** Hardware ids read from the VPN panel. Empty when it was unreachable. */
    readonly hwids?: readonly string[];
    /**
     * Device fingerprints the cabinet observed for this account.
     *
     * Copied here because `device_observations` cascade-deletes with the
     * user, and deleting a banned account is frequently the next thing an
     * operator does. Without this copy the ban would forget the machine at
     * the exact moment the account it belonged to went away.
     */
    readonly deviceFingerprints?: readonly string[];
    readonly reason?: string | null;
    readonly createdById?: string | null;
  }): Promise<{ readonly identities: number; readonly devices: number }> {
    const jobs: Array<{ kind: BlockedIdentityKind; values: string[] }> = [];
    const telegram = telegramIdToBlockedValue(input.telegramId);
    if (telegram !== null) {
      jobs.push({ kind: BlockedIdentityKind.TELEGRAM_ID, values: [telegram] });
    }
    if (typeof input.email === 'string' && input.email.trim().length > 0) {
      jobs.push({ kind: BlockedIdentityKind.EMAIL, values: [input.email] });
    }
    if (typeof input.webLogin === 'string' && input.webLogin.trim().length > 0) {
      jobs.push({ kind: BlockedIdentityKind.WEB_LOGIN, values: [input.webLogin] });
    }
    const hwids = (input.hwids ?? []).filter((value) => value.trim().length > 0);
    if (hwids.length > 0) {
      jobs.push({ kind: BlockedIdentityKind.DEVICE_HWID, values: [...hwids] });
    }
    const fingerprints = (input.deviceFingerprints ?? []).filter(
      (value) => value.trim().length > 0,
    );
    if (fingerprints.length > 0) {
      jobs.push({ kind: BlockedIdentityKind.DEVICE_FP, values: [...fingerprints] });
    }

    let identities = 0;
    let devices = 0;
    for (const job of jobs) {
      const result = await this.addMany({
        kind: job.kind,
        values: job.values,
        reason: input.reason ?? null,
        source: 'cascade',
        createdById: input.createdById ?? null,
        originUserId: input.userId,
      });
      if (
        job.kind === BlockedIdentityKind.DEVICE_HWID ||
        job.kind === BlockedIdentityKind.DEVICE_FP
      ) {
        devices += result.added.length;
      } else {
        identities += result.added.length;
      }
    }
    return { identities, devices };
  }

  /**
   * Drops the `cascade` entries created when this user was blocked.
   *
   * Unblocking has to undo the cascade or an unblocked person stays locked out
   * by the entries their own ban created — a bug that would look exactly like
   * "unblock does nothing". Manually typed entries are left alone on purpose:
   * an operator who listed this id by hand meant it, and a later unblock of one
   * account is not consent to drop that.
   *
   * TWO WAYS OF FINDING THE SAME ROWS, and both are load-bearing. `originUserId`
   * is exact and is the only way a captured DEVICE id can be found at all — it
   * is not derivable from the account. The value lookups additionally catch a
   * cascade row written before that column carried anything, and cost one more
   * OR arm in a query that runs once per unblock.
   */
  public async releaseCascadeForUser(input: {
    readonly userId: string;
    readonly telegramId: bigint | null;
    readonly email: string | null;
    readonly webLogin: string | null;
  }): Promise<number> {
    const lookups: Prisma.BlockedIdentityWhereInput[] = [{ originUserId: input.userId }];
    const telegram = telegramIdToBlockedValue(input.telegramId);
    if (telegram !== null) {
      lookups.push({ kind: BlockedIdentityKind.TELEGRAM_ID, value: telegram });
    }
    for (const [kind, raw] of [
      [BlockedIdentityKind.EMAIL, input.email],
      [BlockedIdentityKind.WEB_LOGIN, input.webLogin],
    ] as const) {
      if (typeof raw !== 'string' || raw.trim().length === 0) continue;
      const normalised = normaliseBlockedIdentity(kind, raw);
      if (normalised.ok) lookups.push({ kind, value: normalised.value });
    }

    const { count } = await this.prismaService.blockedIdentity.deleteMany({
      where: { source: 'cascade', OR: lookups },
    });
    return count;
  }
}

/** An entry with no expiry, or one whose expiry has not passed yet. */
function isLive(entry: BlockedIdentity): boolean {
  return entry.expiresAt === null || entry.expiresAt.getTime() > Date.now();
}

/** Thrown by enforcement points so the refusal reads the same everywhere. */
export class IdentityBlockedException extends BadRequestException {
  public constructor() {
    super('IDENTITY_BLOCKED');
  }
}
