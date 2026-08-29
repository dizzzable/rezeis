import { Injectable, Logger } from '@nestjs/common';
import { UserHint, UserHintDelivery } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

/** What the cabinet reports about itself when it asks for pending hints. */
export interface HintAudience {
  /**
   * `tma` | `pwa` | `browser`, as the cabinet's own three-way probe answers —
   * or `null` when it did not say.
   *
   * `null` is a distinct value on purpose. Substituting a default turns "we
   * cannot tell where this person is" into a positive match against a
   * surface-restricted hint, which is how "install the app" ends up inside
   * Telegram.
   */
  readonly surface: string | null;
  /** `mobile` | `tablet` | `desktop`, or `null` when it did not say. */
  readonly formFactor: string | null;
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
      // LAPSED, NOT DELETED — and the difference was a defect in this method.
      //
      // The once-only rule above counts prior deliveries. Deleting a superseded
      // row removes exactly the evidence that count depends on: a customer who
      // buys, has `welcome` superseded by `paid`, and buys again a week later
      // has no `welcome` row left, so the count reads zero and the once-ever
      // onboarding modal is delivered a second time. The comment above promises
      // that cannot happen; the delete made it happen.
      //
      // Expiring the row keeps it countable, stops it being offered (`nextFor`
      // requires `expiresAt > now`), and — unlike stamping it dismissed — puts
      // no words in the customer's mouth about a hint they never saw.
      const superseded = await this.prismaService.userHintDelivery.updateMany({
        where: {
          userId: input.userId,
          shownAt: null,
          expiresAt: { gt: now },
          hint: { groupKey: hint.groupKey },
        },
        data: { expiresAt: now },
      });
      if (superseded.count > 0) {
        this.logger.debug(
          `Hint group "${hint.groupKey}": lapsed ${superseded.count} unshown delivery(ies) ` +
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
    const row = await this.prismaService.userHintDelivery.findFirst({
      where: {
        userId: input.userId,
        shownAt: null,
        // A CLOSED DELIVERY IS NOT PENDING, and leaving these two terms out was
        // a defect. `shownAt` alone is not enough: the cabinet stamps "shown"
        // fire-and-forget and swallows a failure, so a hint the customer read
        // and dismissed can carry a null `shownAt` for ever — and without this
        // it came back on every page load until it expired, with no way for
        // them to be rid of it.
        dismissedAt: null,
        actedAt: null,
        expiresAt: { gt: now },
        // Read live, which is the whole point of pointing at the library: a
        // hint switched off stops appearing without anybody having to sweep
        // the queue, and switching it back on resumes it.
        hint: { isActive: true, ...this.audienceFilter(input.audience) },
      },
      orderBy: { createdAt: 'asc' },
      include: { hint: true },
    });
    if (row === null) return null;
    return this.resolve(row.id, row.hint, input.locale);
  }

  /**
   * The audience half of the query, as SQL rather than as a post-filter.
   *
   * ── Why it cannot be done in memory ───────────────────────────────────
   *
   * It was, over a bounded page of rows, and that bound was a starvation bug.
   * A delivery failing the filter is never shown, never closed and never
   * removed, so it sits at the head of an ascending-`createdAt` page for its
   * whole TTL. Twenty such rows — one repeatable, surface-restricted hint
   * raised a few times is enough — and every later hint for that person, a
   * failed payment among them, was silently unreachable for up to ninety days.
   *
   * ── An UNKNOWN surface is not a surface ───────────────────────────────
   *
   * When the cabinet does not report one, a restricted hint is SKIPPED rather
   * than matched against a guess. Defaulting it to `browser` turned "we cannot
   * tell" into a positive match and showed "install the app" inside Telegram —
   * precisely what the restriction exists to prevent.
   */
  private audienceFilter(audience: HintAudience): Record<string, unknown> {
    return {
      AND: [
        audience.surface === null
          ? { surfaces: { isEmpty: true } }
          : { OR: [{ surfaces: { isEmpty: true } }, { surfaces: { has: audience.surface } }] },
        audience.formFactor === null
          ? { formFactors: { isEmpty: true } }
          : {
              OR: [
                { formFactors: { isEmpty: true } },
                { formFactors: { has: audience.formFactor } },
              ],
            },
      ],
    };
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
