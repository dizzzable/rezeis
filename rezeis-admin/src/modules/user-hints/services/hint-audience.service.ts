import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';

/** Audiences a scheduled rule may address. */
export const HINT_AUDIENCES = ['paid-not-connected'] as const;
export type HintAudienceName = (typeof HINT_AUDIENCES)[number];

/** What one audience resolution found, and whether it could look at all. */
export type AudienceOutcome =
  | { readonly kind: 'ok'; readonly userIds: readonly string[]; readonly truncated: boolean }
  | { readonly kind: 'blind'; readonly reason: string };

/**
 * Ceiling on one run. A rule that would hint more people than this is not a
 * nudge, it is a broadcast, and it is far likelier to be a misconfiguration —
 * or the blindness below going undetected — than a real cohort.
 */
const MAX_USERS_PER_RUN = 500;

/**
 * Who to hint, for the cases where the trigger is the ABSENCE of something.
 *
 * ── Why this cannot be an event ───────────────────────────────────────────
 *
 * Every other hint follows something that happened: a payment cleared, a
 * device was unbound. The most useful hint of all follows something that did
 * NOT happen — the customer paid a day ago and has still never connected —
 * and nothing emits an event for a thing not occurring. So it is a query, run
 * on a schedule, and this is where that query lives.
 *
 * ── THE FAILURE MODE THIS IS BUILT AROUND ─────────────────────────────────
 *
 * `User.firstTrafficAt` is the only marker of "has connected", and exactly one
 * thing writes it: the Remnawave `user.first_connected` / bandwidth webhook.
 * On an install where webhooks were never configured — or where they broke —
 * that column is NULL for absolutely everybody.
 *
 * Read naively, that says every customer who ever paid has never connected,
 * and the rule would send a "here is how to connect" modal to the entire
 * customer base, including people who have been connected for months. That is
 * not a smaller version of working correctly; it is the worst outcome the
 * whole hint feature can produce, because it teaches every customer at once
 * that our hints are noise.
 *
 * So the resolver asks a second question first: does ANY account in this
 * install carry a `firstTrafficAt`? If none does, the signal is not working
 * and the answer is `blind` — the rule stands down and says why. "We looked
 * and nobody has connected" and "we cannot tell who has connected" are
 * different facts, and only the first is safe to act on.
 */
@Injectable()
export class HintAudienceService {
  private readonly logger = new Logger(HintAudienceService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  public async resolve(input: {
    readonly audience: HintAudienceName;
    /** Only subscriptions at least this old. Default a day. */
    readonly afterHours?: number;
    /** …and no older than this. Default three days. */
    readonly beforeHours?: number;
    readonly now?: Date;
  }): Promise<AudienceOutcome> {
    const now = input.now ?? new Date();
    const afterHours = input.afterHours ?? 24;
    const beforeHours = input.beforeHours ?? 72;
    if (afterHours >= beforeHours) {
      return {
        kind: 'blind',
        reason: `the window is empty: afterHours (${afterHours}) must be less than beforeHours (${beforeHours})`,
      };
    }

    // ── Can we tell who has connected at all? ──────────────────────────
    const anyConnected = await this.prismaService.user.count({
      where: { firstTrafficAt: { not: null } },
      take: 1,
    });
    if (anyConnected === 0) {
      return {
        kind: 'blind',
        reason:
          'no account in this install has a first-traffic timestamp, so "has never connected" ' +
          'cannot be told from "we were never told". `User.firstTrafficAt` is written only by ' +
          'the Remnawave webhook — check that webhooks are configured and arriving before ' +
          'relying on this audience.',
      };
    }

    // A WINDOW, not "older than": an open-ended lower bound would re-scan the
    // entire history on every run, and the hint's own once-only rule would be
    // the only thing standing between that and a daily sweep of every customer
    // who ever failed to connect. Bounding it here keeps the query small and
    // the intent honest — this is about people who bought RECENTLY.
    const createdAfter = new Date(now.getTime() - beforeHours * 60 * 60 * 1000);
    const createdBefore = new Date(now.getTime() - afterHours * 60 * 60 * 1000);

    const rows = await this.prismaService.user.findMany({
      where: {
        isBlocked: false,
        firstTrafficAt: null,
        subscriptions: {
          some: {
            createdAt: { gte: createdAfter, lte: createdBefore },
            // A trial counts: somebody who took a free trial and never
            // connected is precisely who this is for.
            status: { in: ['ACTIVE', 'LIMITED'] },
          },
        },
      },
      select: { id: true },
      // Oldest first, so a run that hits the ceiling takes the people who have
      // been waiting longest rather than an arbitrary slice.
      orderBy: { createdAt: 'asc' },
      take: MAX_USERS_PER_RUN + 1,
    });

    const truncated = rows.length > MAX_USERS_PER_RUN;
    if (truncated) {
      this.logger.warn(
        `Hint audience "${input.audience}" matched more than ${MAX_USERS_PER_RUN} accounts. ` +
          'Only the longest-waiting were taken this run. An audience this large is more often a ' +
          'misconfigured window than a real cohort — check the hours before widening the cap.',
      );
    }
    return {
      kind: 'ok',
      userIds: rows.slice(0, MAX_USERS_PER_RUN).map((row) => row.id),
      truncated,
    };
  }
}
