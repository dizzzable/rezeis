import { Injectable, Logger } from '@nestjs/common';

import {
  CONNECT_AUDIENCE_STATEMENT_TIMEOUT,
  ConnectAudienceService,
  ConnectAudienceTooLargeError,
  isStatementTimeout,
  type ConnectBucket,
} from '../../connect-audience/services/connect-audience.service';

/**
 * Audiences a scheduled rule may address.
 *
 * Three names, two of them buckets of «Купил, но не подключился» and one the
 * name every rule saved before the split holds. That one stays valid for ever:
 * it is stored as a plain string in `automation_rules.actions[].params`, and a
 * rule whose audience stopped being accepted would fail every night from the
 * night of the upgrade.
 */
export const HINT_AUDIENCES = ['purchase-not-connected', 'trial-not-connected', 'paid-not-connected'] as const;
export type HintAudienceName = (typeof HINT_AUDIENCES)[number];

/**
 * The name rules saved before the split hold. Its label says «Оплатил» and it
 * always included trials, so it now means exactly what it did — every bucket —
 * and is labelled so; the editor offers it only to a rule that already has it.
 */
export const LEGACY_HINT_AUDIENCE: HintAudienceName = 'paid-not-connected';

/**
 * Which buckets of `ConnectAudienceService` each audience reads.
 *
 *   purchase-not-connected   «Оплатил и не подключился» — paid money, a paid
 *                            trial and a partner-balance purchase included;
 *   trial-not-connected      «Пробный период или подарок — не подключился»;
 *   paid-not-connected       both, each by its own window: the payment's time
 *                            for the paid bucket, the grant for the trial one.
 */
export const HINT_AUDIENCE_BUCKETS: Readonly<Record<HintAudienceName, readonly ConnectBucket[]>> = {
  'purchase-not-connected': ['paid'],
  'trial-not-connected': ['trial'],
  'paid-not-connected': ['paid', 'trial'],
};

/** Why an audience was refused rather than resolved. Both hint nobody. */
export type AudienceRefusalCause = 'too_large' | 'timeout';

/** What one audience resolution found, and whether it could look at all. */
export type AudienceOutcome =
  | { readonly kind: 'ok'; readonly userIds: readonly string[]; readonly truncated: boolean }
  | { readonly kind: 'blind'; readonly reason: string }
  | {
      readonly kind: 'refused';
      readonly cause: AudienceRefusalCause;
      readonly reason: string;
      /** The ceiling that was passed, for `too_large`; `null` otherwise. */
      readonly limit: number | null;
    };

/**
 * Ceiling on one run. A rule that would hint more people than this is not a
 * nudge, it is a broadcast, and it is far likelier to be a misconfiguration
 * than a real cohort. The longest-waiting are taken and the run says it was
 * capped.
 */
const MAX_USERS_PER_RUN = 500;

const HOUR_MS = 60 * 60 * 1000;

/**
 * The reason a rule stands down on a blind signal, in the words its run log
 * keeps. The panel words it for the operator from the result's `cause`; this is
 * the log's and an older panel's copy.
 */
const SIGNAL_BLIND_REASON =
  'the panel cannot tell right now who has connected: the connection check has read nothing ' +
  'from Remnawave for 30 minutes and no Remnawave user webhook arrived in the last 24 hours, so ' +
  '"never connected" cannot be told from "could not look". Check the panel\'s connection to ' +
  'Remnawave, or its webhooks';

/**
 * Who to hint, for the cases where the trigger is the ABSENCE of something.
 *
 * ── Why this cannot be an event ───────────────────────────────────────────
 *
 * Every other hint follows something that happened. The most useful one
 * follows something that did NOT happen — the customer paid a day ago and has
 * still never connected — and a schedule is how that is asked. (The automatic
 * help now also emits `subscription.not_connected`, which a pop-up can follow
 * directly; this is the operator's own schedule beside it.)
 *
 * ── WHERE "NOT CONNECTED" COMES FROM ───────────────────────────────────────
 *
 * `ConnectAudienceService`, and nothing else. A person is named only when a
 * successful read of their profile, made after the purchase (or the grant) and
 * at most a day old, found it never connected — the per-subscription signal
 * the broadcast filter «Подключение VPN» reads. The old question, "does this
 * PERSON have a first-traffic timestamp", counted "we were never told" as
 * "never connected", and could only guard against that by asking whether ANY
 * account in the install had one.
 *
 * ── STANDING DOWN ──────────────────────────────────────────────────────────
 *
 * When the signal is `blind` — the check has not reached Remnawave for half an
 * hour and no webhook arrived in a day — the answer is `blind`, and the rule
 * hints nobody. The other states proceed: in them nobody is named without a
 * fresh read, so a slow or partial signal can only name FEWER people.
 *
 * ── THE HINT IS ITS OWN CHANNEL ────────────────────────────────────────────
 *
 * `excludeHelped` is off. It leaves out subscriptions the automatic help or a
 * broadcast already reached — right for a second MESSAGE, wrong here: the
 * pop-up is shown after the message on purpose, and the hint's own once-only
 * rule and group are what keep it from repeating.
 */
@Injectable()
export class HintAudienceService {
  private readonly logger = new Logger(HintAudienceService.name);

  public constructor(private readonly connectAudienceService: ConnectAudienceService) {}

  public async resolve(input: {
    readonly audience: HintAudienceName;
    /** Only purchases (or grants) at least this old. Default a day. */
    readonly afterHours?: number;
    /** …and no older than this. Default three days. */
    readonly beforeHours?: number;
    readonly now?: Date;
  }): Promise<AudienceOutcome> {
    const now = input.now ?? new Date();
    const afterHours = input.afterHours ?? 24;
    const beforeHours = input.beforeHours ?? 72;
    if (afterHours >= beforeHours) {
      // Answered from the arguments alone: taking a connection to say so would
      // be a wait with nothing to show for it.
      return {
        kind: 'blind',
        reason: `the window is empty: afterHours (${afterHours}) must be less than beforeHours (${beforeHours})`,
      };
    }
    const buckets = HINT_AUDIENCE_BUCKETS[input.audience];
    if (buckets === undefined) {
      throw new RangeError(`hint audience: unknown audience ${String(input.audience)}`);
    }
    // A WINDOW, not "older than": an open-ended lower bound would re-scan the
    // whole history on every run. `from` is the far end.
    const window = {
      from: new Date(now.getTime() - beforeHours * HOUR_MS),
      to: new Date(now.getTime() - afterHours * HOUR_MS),
    };

    const health = await this.connectAudienceService.health(now);
    if (health.state === 'blind') {
      this.logger.warn(`Hint audience "${input.audience}" stood down: ${SIGNAL_BLIND_REASON}`);
      return { kind: 'blind', reason: SIGNAL_BLIND_REASON };
    }

    // One bucket after the other, not in parallel: the legacy name reads two,
    // and each already holds a connection for up to its own bound
    // (`CONNECT_AUDIENCE_TRANSACTION_OPTIONS`). A refusal of the first spares
    // the second.
    const lists: string[][] = [];
    try {
      for (const bucket of buckets) {
        lists.push(
          await this.connectAudienceService.userIds({ bucket, window, excludeHelped: false, now }),
        );
      }
    } catch (error) {
      const refusal = refusalOf(error, input.audience);
      if (refusal === null) throw error;
      this.logger.warn(`Hint audience "${input.audience}" was refused: ${refusal.reason}`);
      return refusal;
    }

    const people = interleaveDistinct(lists);
    const truncated = people.length > MAX_USERS_PER_RUN;
    if (truncated) {
      this.logger.warn(
        `Hint audience "${input.audience}" matched more than ${MAX_USERS_PER_RUN} accounts. ` +
          'Only the longest-waiting were taken this run. An audience this large is more often a ' +
          'misconfigured window than a real cohort — check the hours before widening the cap.',
      );
    }
    return { kind: 'ok', userIds: people.slice(0, MAX_USERS_PER_RUN), truncated };
  }
}

/** The refusal an error from the audience service stands for, or `null` for any other error. */
function refusalOf(
  error: unknown,
  audience: HintAudienceName,
): Extract<AudienceOutcome, { readonly kind: 'refused' }> | null {
  if (error instanceof ConnectAudienceTooLargeError) {
    return {
      kind: 'refused',
      cause: 'too_large',
      limit: error.limit,
      reason:
        `more than ${error.limit} people are verified as not connected for "${audience}" — too many ` +
        'for a pop-up, so nobody was hinted. If the rule sets its own window (afterHours, ' +
        'beforeHours), narrow it; to reach this many people, send a broadcast with the ' +
        '«Подключение VPN» filter',
    };
  }
  if (isStatementTimeout(error)) {
    return {
      kind: 'refused',
      cause: 'timeout',
      limit: null,
      reason:
        `working out the "${audience}" audience took longer than ${CONNECT_AUDIENCE_STATEMENT_TIMEOUT} ` +
        'and the database stopped it, so nobody was hinted; the next run tries again',
    };
  }
  return null;
}

/**
 * The lists merged one from each in turn, each person once.
 *
 * Every list comes oldest anchor first, and the anchors of two buckets are
 * different moments (a payment, a grant), so there is no single order to merge
 * them by. Taking one from each in turn keeps each bucket's longest-waiting at
 * the front, so a capped run is not all one bucket.
 */
function interleaveDistinct(lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      const id = list[index];
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
}
