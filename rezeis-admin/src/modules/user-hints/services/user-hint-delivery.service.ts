import { Injectable, Logger } from '@nestjs/common';
import { UserHint, UserHintDelivery } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

/** What the cabinet reports about itself when it asks for pending hints. */
export interface HintAudience {
  /** `tma` | `pwa` | `browser`, as the cabinet's own three-way probe answers. */
  readonly surface: string;
  /** `mobile` | `tablet` | `desktop`. */
  readonly formFactor: string;
}

/** One hint, resolved for one viewer. */
export interface ResolvedHint {
  readonly deliveryId: string;
  readonly key: string;
  readonly mode: string;
  readonly tone: string;
  readonly title: string;
  readonly body: string;
  readonly ctaKind: string;
  readonly ctaLabel: string | null;
  readonly ctaTarget: string | null;
}

/**
 * The queue: raising a hint for somebody, and handing it over when they appear.
 *
 * ── Why this is a queue at all ────────────────────────────────────────────
 *
 * The moment a hint is EARNED and the moment it can be SHOWN are different
 * moments and nothing lines them up. A card payment's webhook usually lands
 * before the browser has finished redirecting back; a crypto payment confirms
 * twenty minutes after the buyer closed the tab; an operator unbinding a device
 * at 03:00 has no audience at all. Showing at raise time would mean showing to
 * nobody.
 */
@Injectable()
export class UserHintDeliveryService {
  private readonly logger = new Logger(UserHintDeliveryService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Owes `hintKey` to `userId`.
   *
   * Returns the row, or `null` when nothing was queued — which is a normal
   * outcome, not a failure, and happens for four separate reasons the caller
   * does not need to tell apart: the hint does not exist, it is switched off,
   * the user has already had it and it is not repeatable, or a newer hint in
   * the same group superseded it.
   */
  public async raise(input: {
    readonly userId: string;
    readonly hintKey: string;
    readonly source: string;
    readonly now?: Date;
  }): Promise<UserHintDelivery | null> {
    const now = input.now ?? new Date();
    const hint = await this.prismaService.userHint.findUnique({
      where: { key: input.hintKey },
    });
    if (hint === null) {
      // Loud, because it is always a mistake: a rule or a client moment naming
      // a hint nobody authored will silently do nothing on every single fire.
      this.logger.warn(
        `Hint "${input.hintKey}" was raised for a user but no such hint exists — ` +
          `nothing was queued (source: ${input.source})`,
      );
      return null;
    }
    if (!hint.isActive) return null;

    if (!hint.isRepeatable) {
      // ANY prior delivery counts, shown or not. "Once" has to mean once even
      // when the first one is still sitting unseen, or a customer who buys
      // twice in a week gets the same onboarding modal twice.
      const seen = await this.prismaService.userHintDelivery.count({
        where: { userId: input.userId, hintId: hint.id },
      });
      if (seen > 0) return null;
    }

    // ── Supersession ─────────────────────────────────────────────────────
    // One purchase emits four events, and an operator who binds a hint to each
    // has queued four modals for one act. A shared `groupKey` says "these are
    // about the same thing": the newest wins and the older UNSHOWN ones are
    // dropped. Already-shown rows are left alone — they are history, and
    // rewriting history to tidy a queue is how a delivery log stops being
    // evidence.
    if (hint.groupKey !== null) {
      const superseded = await this.prismaService.userHintDelivery.deleteMany({
        where: {
          userId: input.userId,
          shownAt: null,
          hint: { groupKey: hint.groupKey },
        },
      });
      if (superseded.count > 0) {
        this.logger.debug(
          `Hint group "${hint.groupKey}": dropped ${superseded.count} unshown delivery(ies) ` +
            `in favour of "${hint.key}"`,
        );
      }
    }

    return this.prismaService.userHintDelivery.create({
      data: {
        userId: input.userId,
        hintId: hint.id,
        source: input.source,
        // Resolved HERE and stored, never re-read from the hint. An operator
        // lengthening the TTL later must not resurrect rows that had already
        // lapsed — a customer meeting a hint about a payment that failed three
        // weeks ago.
        expiresAt: new Date(now.getTime() + hint.ttlHours * 60 * 60 * 1000),
      },
    });
  }

  /**
   * The next hint this person should see, or `null`.
   *
   * ONE AT A TIME, and oldest first. One at a time because a customer walking
   * through the cabinet with three queued hints would meet a modal on every
   * screen; oldest first because a sequence only reads correctly in the order
   * it happened — "your card was declined" belongs before "your subscription
   * ended", never after.
   *
   * The audience filter is applied HERE rather than in the query because it
   * reads two array columns against two scalars, and expressing that in SQL
   * costs more than filtering a handful of rows in memory. The queue for one
   * person is small by construction.
   */
  public async nextFor(input: {
    readonly userId: string;
    readonly locale: 'ru' | 'en';
    readonly audience: HintAudience;
    readonly now?: Date;
  }): Promise<ResolvedHint | null> {
    const now = input.now ?? new Date();
    const rows = await this.prismaService.userHintDelivery.findMany({
      where: {
        userId: input.userId,
        shownAt: null,
        expiresAt: { gt: now },
        // Read live, which is the whole point of pointing at the library: a
        // hint switched off stops appearing without anybody having to sweep
        // the queue, and switching it back on resumes it.
        hint: { isActive: true },
      },
      orderBy: { createdAt: 'asc' },
      include: { hint: true },
      // Bounded: if a person has more than this pending, the tail is stale by
      // definition and the audience filter has plenty to choose from.
      take: 20,
    });

    for (const row of rows) {
      if (!this.matchesAudience(row.hint, input.audience)) continue;
      return this.resolve(row.id, row.hint, input.locale);
    }
    return null;
  }

  /** Marks it as put on screen. Idempotent — a re-render must not re-stamp. */
  public async markShown(deliveryId: string, userId: string): Promise<boolean> {
    const outcome = await this.prismaService.userHintDelivery.updateMany({
      where: { id: deliveryId, userId, shownAt: null },
      data: { shownAt: new Date() },
    });
    return outcome.count > 0;
  }

  /**
   * Records how it ended.
   *
   * `acted` and `dismissed` are stamped separately and deliberately: collapsing
   * them makes "this hint helps" indistinguishable from "people close it to be
   * rid of it", which is the only question worth asking of a hint.
   */
  public async close(
    deliveryId: string,
    userId: string,
    outcome: 'acted' | 'dismissed',
  ): Promise<boolean> {
    const now = new Date();
    const result = await this.prismaService.userHintDelivery.updateMany({
      where: { id: deliveryId, userId, dismissedAt: null, actedAt: null },
      data: outcome === 'acted' ? { actedAt: now } : { dismissedAt: now },
    });
    return result.count > 0;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Is this hint meant for a viewer on this surface and form factor?
   *
   * An EMPTY list means "everywhere" — the common case, and the reason the
   * filter costs nothing for most hints. A non-empty one is for the handful
   * that are actively WRONG in the wrong place: "install the app" shown to
   * somebody running the installed app, "open our bot" to somebody already
   * inside Telegram. An operator who sends those teaches customers to dismiss
   * hints unread, and then the useful ones go with them.
   */
  private matchesAudience(hint: UserHint, audience: HintAudience): boolean {
    if (hint.surfaces.length > 0 && !hint.surfaces.includes(audience.surface)) return false;
    if (hint.formFactors.length > 0 && !hint.formFactors.includes(audience.formFactor)) {
      return false;
    }
    return true;
  }

  /** Picks the locale copy, falling back to RU exactly like the templates do. */
  private resolve(deliveryId: string, hint: UserHint, locale: 'ru' | 'en'): ResolvedHint {
    const pick = (ru: string, en: string | null): string =>
      locale === 'en' && en !== null && en.length > 0 ? en : ru;
    return {
      deliveryId,
      key: hint.key,
      mode: hint.mode,
      tone: hint.tone,
      title: pick(hint.titleRu, hint.titleEn),
      body: pick(hint.bodyRu, hint.bodyEn),
      ctaKind: hint.ctaKind,
      ctaLabel:
        hint.ctaLabelRu === null ? null : pick(hint.ctaLabelRu, hint.ctaLabelEn),
      ctaTarget: hint.ctaTarget,
    };
  }
}
