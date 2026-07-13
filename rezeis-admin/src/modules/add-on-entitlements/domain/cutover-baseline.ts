import { TrafficLimitStrategy } from '@prisma/client';

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
 * The term window is provenance during rollout (reset/expiry stay disabled):
 * `startsAt = createdAt`, `endsAt = expiresAt` only when it is strictly after
 * `startsAt` (otherwise `null`, so the additive CHECK `ends_at > starts_at`
 * always holds).
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

  const startsAt = input.createdAt;
  let endsAt: Date | null;
  if (input.expiresAt === null) {
    endsAt = null;
  } else if (input.expiresAt.getTime() > startsAt.getTime()) {
    endsAt = input.expiresAt;
  } else {
    reasons.push('NON_POSITIVE_TERM_WINDOW');
    endsAt = null;
  }

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
