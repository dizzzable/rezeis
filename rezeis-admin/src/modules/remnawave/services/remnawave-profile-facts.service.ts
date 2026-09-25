import { Injectable, Logger } from '@nestjs/common';
import { SubscriptionStatus, SubscriptionTermStatus, TrafficLimitStrategy } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  readRemnawaveProfileFacts,
  type RemnawaveProfileFacts,
  stampRemnawaveProfileFacts,
} from '../utils/remnawave-profile-facts.util';
import { storedIdentityOf } from './panel-user-address';
import { RemnawaveApiService } from './remnawave-api.service';

/**
 * How long a caller waits for the one read. The offer asks while a customer
 * waits for the add-on screen, and Remnawave answers from the next host in
 * milliseconds when it is healthy — the shared outbound timeout (45 s) is for
 * writes that must land, not for a read whose absence only withholds.
 */
export const PROFILE_FACTS_READ_DEADLINE_MS = 3_000;

/**
 * After a read that learnt nothing (the panel down, the profile missing, no
 * `createdAt`), the same subscription is not asked again for this long: an
 * offer opened ten times during an outage must not cost ten reads of a dead
 * panel. A stamp from any other answer (a webhook, a push) ends it early,
 * because the column is read first.
 */
export const PROFILE_FACTS_MISS_MEMO_MS = 60_000;

/** The memo never grows past this; past it, it starts over. */
const MISS_MEMO_LIMIT = 10_000;

/**
 * THE PROFILE FACTS, READ ONCE WHEN THE PANEL HAS NOT HEARD THEM YET.
 *
 * The two columns `remnawave-profile-facts.util.ts` stamps are filled from
 * every answer of Remnawave's the panel sees. A subscription nothing has
 * answered for since the columns existed has neither — and a MONTH_ROLLING
 * sale cannot be dated without the profile's `createdAt`. This reads the
 * profile ONCE, stamps what it said, and answers.
 *
 * Single-flight per subscription: callers asking at the same time share one
 * read. A read that outlives {@link PROFILE_FACTS_READ_DEADLINE_MS} answers
 * `null` to its callers and still stamps when it lands.
 */
@Injectable()
export class RemnawaveProfileFactsService {
  private readonly logger = new Logger(RemnawaveProfileFactsService.name);
  private readonly inFlight = new Map<string, Promise<RemnawaveProfileFacts | null>>();
  /** Subscription id → until when a read that learnt nothing is not repeated. */
  private readonly misses = new Map<string, number>();

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  /**
   * The Remnawave profile's `createdAt` for `subscriptionId` — MONTH_ROLLING's
   * anchor: the stamped `remnawave_profile_created_at` when the panel has it;
   * otherwise ONE read of the profile, stamped, and its `createdAt`. `null`
   * when it is still unknown — no linked profile, a DELETED row, the panel
   * down or slower than {@link PROFILE_FACTS_READ_DEADLINE_MS}, the profile
   * missing — which a seller must read as "withhold", never as "guess".
   *
   * Never throws: a failed read is `null`, and the reason is logged.
   */
  public async readProfileCreatedAtOnce(subscriptionId: string, now: Date = new Date()): Promise<Date | null> {
    const row = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: { remnawaveProfileCreatedAt: true },
    });
    if (row === null) return null;
    if (row.remnawaveProfileCreatedAt !== null) return row.remnawaveProfileCreatedAt;
    return (await this.refreshProfileFacts(subscriptionId, now))?.createdAt ?? null;
  }

  /**
   * ONE read of the subscription's Remnawave profile, whose `createdAt` and
   * `lastTrafficResetAt` are stamped before this answers — the columns under
   * their rules, and the `createdAt` onto the live MONTH_ROLLING terms as their
   * reset anchor, as profile sync does. Answers what the read said, or `null`
   * when there was nothing to read or it learnt nothing (then the same
   * subscription is not asked again for {@link PROFILE_FACTS_MISS_MEMO_MS}).
   */
  public async refreshProfileFacts(subscriptionId: string, now: Date = new Date()): Promise<RemnawaveProfileFacts | null> {
    const missUntil = this.misses.get(subscriptionId);
    if (missUntil !== undefined && missUntil > now.getTime()) return null;
    let pending = this.inFlight.get(subscriptionId);
    if (pending === undefined) {
      const started = this.readAndStamp(subscriptionId, now);
      pending = started;
      this.inFlight.set(subscriptionId, started);
      void started.finally(() => {
        // Only this read's own slot: a newer read may already hold it.
        if (this.inFlight.get(subscriptionId) === started) this.inFlight.delete(subscriptionId);
      });
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PROFILE_FACTS_READ_DEADLINE_MS);
    });
    try {
      return await Promise.race([pending, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async readAndStamp(subscriptionId: string, now: Date): Promise<RemnawaveProfileFacts | null> {
    try {
      const row = await this.prismaService.subscription.findUnique({
        where: { id: subscriptionId },
        select: {
          status: true,
          remnawaveId: true,
          remnawavePanelId: true,
          remnawavePanelUsername: true,
          configUrl: true,
        },
      });
      const identity = row === null || row.status === SubscriptionStatus.DELETED ? null : storedIdentityOf(row);
      if (identity === null) return this.missed(subscriptionId, now);
      const outcome = await this.remnawaveApiService.getPanelUserOutcome(identity);
      if (outcome.kind !== 'ok') return this.missed(subscriptionId, now);
      const facts = readRemnawaveProfileFacts(outcome.user);
      if (facts.createdAt === null && facts.lastTrafficResetAt === null) return this.missed(subscriptionId, now);
      await stampRemnawaveProfileFacts(this.prismaService, [subscriptionId], facts);
      if (facts.createdAt !== null) {
        await this.prismaService.subscriptionTerm.updateMany({
          where: {
            subscriptionId,
            status: { in: [SubscriptionTermStatus.ACTIVE, SubscriptionTermStatus.SCHEDULED] },
            trafficResetStrategy: TrafficLimitStrategy.MONTH_ROLLING,
            OR: [{ resetAnchorAt: null }, { resetAnchorAt: { not: facts.createdAt } }],
          },
          data: { resetAnchorAt: facts.createdAt },
        });
      }
      this.misses.delete(subscriptionId);
      return facts;
    } catch (error: unknown) {
      this.logger.warn(
        `Remnawave profile facts not read for subscription ${subscriptionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.missed(subscriptionId, now);
    }
  }

  private missed(subscriptionId: string, now: Date): null {
    if (this.misses.size >= MISS_MEMO_LIMIT) this.misses.clear();
    this.misses.set(subscriptionId, now.getTime() + PROFILE_FACTS_MISS_MEMO_MS);
    return null;
  }
}
