/**
 * Per-detector-code accuracy, as the admin panel reads it.
 *
 * The shape is deliberately explicit about WHO closed a signal, because the one
 * question this report exists to answer — "how often is this detector wrong?" —
 * is only answerable from the closes a human made. See
 * `services/detector-accuracy.service.ts` for the reasoning behind the
 * numerator and the denominator.
 */

/**
 * How many operator verdicts a code needs before its false-positive rate is
 * shown as a percentage at all.
 *
 * Ten, and the exact value matters less than the fact that there is one. A rate
 * computed from two verdicts swings 50 points on the third; an operator reading
 * "67% false positives" off three signals would raise a threshold on the
 * strength of a coin flip, which is worse than having no number — the whole
 * point of this surface is to replace hand-tuning by intuition with something
 * that can be trusted. Ten keeps a single verdict's leverage to 10 points and
 * is reachable within days on any code that fires regularly; a code that cannot
 * reach it in the window is telling the operator something too, which is why
 * such codes are still listed with their raw counts rather than hidden.
 */
export const MIN_ADJUDICATED_FOR_RATE = 10;

export interface DetectorAccuracyRow {
  /** `FraudSignal.code`, e.g. `SUBSCRIPTION_SHARING_HWID`. */
  readonly code: string;
  /** Signals this code OPENED inside the window, whatever became of them. */
  readonly total: number;
  /** Still open — nobody has ruled on these. */
  readonly open: number;
  /** A human took ownership but has not closed it. */
  readonly acknowledged: number;
  /** Every RESOLVED row, however it got there. `operatorResolved + autoResolved`. */
  readonly resolved: number;
  /** RESOLVED by a named admin — an operator saying the signal was real and handled. */
  readonly operatorResolved: number;
  /** RESOLVED with a null resolver — the detector run itself stopped seeing the condition. */
  readonly autoResolved: number;
  /** DISMISSED by a named admin: the operator's "false positive" verdict. */
  readonly dismissed: number;
  /**
   * DISMISSED with a null resolver. Zero on every deployment today — nothing
   * writes it — and counted anyway so that if something ever does, it does not
   * quietly inflate the false-positive numerator.
   */
  readonly systemDismissed: number;
  /** `dismissed + operatorResolved` — the signals a human actually ruled on. */
  readonly adjudicated: number;
  /**
   * `dismissed / adjudicated` as a percentage to one decimal, or `null` when
   * `adjudicated` is below {@link MIN_ADJUDICATED_FOR_RATE}. `null` means "not
   * enough verdicts to say", and is NOT interchangeable with `0`.
   */
  readonly falsePositiveRate: number | null;
}

export interface DetectorAccuracyReport {
  readonly windowDays: number;
  /** Inclusive lower bound on `detectedAt`, ISO-8601. */
  readonly since: string;
  /** Inclusive upper bound on `detectedAt`, ISO-8601 — the moment of the read. */
  readonly until: string;
  /** Echoed so the UI can explain a suppressed rate without hardcoding the floor. */
  readonly minAdjudicatedForRate: number;
  /** Busiest code first; empty when nothing fired in the window. */
  readonly rows: readonly DetectorAccuracyRow[];
}
