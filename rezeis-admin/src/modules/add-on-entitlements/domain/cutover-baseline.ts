import { TrafficLimitStrategy } from '@prisma/client';

import { boundedTermWindow } from './term-window';

/**
 * Grandfather-cutover baseline derivation (pure).
 *
 * Maps a legacy subscription's local limits to a canonical `SubscriptionTerm`
 * baseline for the add-on entitlement model. This is the money-/limit-sensitive
 * mapping, kept pure so it can be exhaustively unit-tested without a database.
 *
 * Canonical unlimited is `null`:
 *  - Traffic: legacy `trafficLimit` (GB) is `null` ⇒ unlimited ⇒ `null` bytes.
 *    A finite value converts to bytes (`GB × 1024³`); `0 GB` is a real finite
 *    zero limit, NOT unlimited.
 *  - Devices: legacy `deviceLimit` is `Int @default(0)` and the product treats
 *    `deviceLimit <= 0` as unlimited (sharing detection, devices UI and the
 *    panel device-limit mapping all agree). So `<= 0` ⇒ `null` (unlimited).
 *    This also removes the legacy footgun where buying EXTRA_DEVICES turned an
 *    unlimited subscription finite via `0 + N = N`.
 *
 * The term window ends where the subscription does: `endsAt = expiresAt`, and
 * `startsAt = createdAt`, pulled back to `expiresAt − 1 s` when `createdAt` is
 * not strictly before it (`boundedTermWindow`). So the additive CHECK
 * `ends_at > starts_at` always holds, and the term is open-ended ONLY for a
 * lifetime subscription (`expiresAt = null`). A lapsed import used to get an
 * open end here, which the renewal producer cannot append after — a paid
 * renewal was then left unfulfilled. `NON_POSITIVE_TERM_WINDOW` still marks
 * such a row AMBIGUOUS, because `expiresAt <= createdAt` is a data anomaly worth
 * counting; the term itself is now well-formed.
 */
export const GIB_BYTES = 1024n * 1024n * 1024n;

const VALID_RESET_STRATEGIES: ReadonlySet<string> = new Set<TrafficLimitStrategy>([
  TrafficLimitStrategy.NO_RESET,
  TrafficLimitStrategy.DAY,
  TrafficLimitStrategy.WEEK,
  TrafficLimitStrategy.MONTH,
  TrafficLimitStrategy.MONTH_ROLLING,
]);

export type CutoverClassification = 'MATCHED' | 'AMBIGUOUS';

export interface CutoverBaselineInput {
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

export interface CutoverBaseline {
  readonly baseTrafficLimitBytes: bigint | null;
  readonly baseDeviceLimit: number | null;
  readonly trafficResetStrategy: TrafficLimitStrategy;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly classification: CutoverClassification;
  readonly ambiguousReasons: readonly string[];
}

export function deriveCutoverBaseline(input: CutoverBaselineInput): CutoverBaseline {
  const reasons: string[] = [];

  let baseTrafficLimitBytes: bigint | null;
  if (input.trafficLimit === null) {
    baseTrafficLimitBytes = null;
  } else if (!Number.isInteger(input.trafficLimit) || input.trafficLimit < 0) {
    // Legacy `trafficLimit` is a non-negative Int; anything else is a data
    // anomaly. Never fabricate a limit — flag it and fall back to a finite 0.
    reasons.push('NON_INTEGER_OR_NEGATIVE_TRAFFIC');
    baseTrafficLimitBytes = 0n;
  } else {
    baseTrafficLimitBytes = BigInt(input.trafficLimit) * GIB_BYTES;
  }

  // Devices: `<= 0` is the product's canonical unlimited.
  const baseDeviceLimit = input.deviceLimit <= 0 ? null : input.deviceLimit;

  let trafficResetStrategy: TrafficLimitStrategy;
  if (input.trafficLimitStrategy !== null && VALID_RESET_STRATEGIES.has(input.trafficLimitStrategy)) {
    trafficResetStrategy = input.trafficLimitStrategy as TrafficLimitStrategy;
  } else {
    reasons.push('UNKNOWN_RESET_STRATEGY');
    trafficResetStrategy = TrafficLimitStrategy.NO_RESET;
  }

  if (input.expiresAt !== null && input.expiresAt.getTime() <= input.createdAt.getTime()) {
    reasons.push('NON_POSITIVE_TERM_WINDOW');
  }
  const { startsAt, endsAt } = boundedTermWindow(input.createdAt, input.expiresAt);

  return {
    baseTrafficLimitBytes,
    baseDeviceLimit,
    trafficResetStrategy,
    startsAt,
    endsAt,
    classification: reasons.length > 0 ? 'AMBIGUOUS' : 'MATCHED',
    ambiguousReasons: reasons,
  };
}
