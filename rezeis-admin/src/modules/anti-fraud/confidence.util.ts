/**
 * How a detector turns the evidence it actually held into a `confidence`.
 *
 * WHY THIS EXISTS. Every detector in this module used to report `confidence`
 * as a literal — 90, 80, 75, 70, 65, 60, 55 — written once and thereafter
 * asserted about every signal the detector ever raised. A user one device over
 * a limit of ten and a user with thirty devices against a limit of two both
 * came back "80% confident". A network count derived from three IP sightings
 * and one derived from three hundred both came back "60". That is not a
 * confidence; it is a per-detector label, and an operator who learned to trust
 * the number learned something false.
 *
 * THE MODEL. Taken from the reference implementation studied for this project
 * (Case211/remnawave-admin), which computes
 *
 *     score_factor × (0.4 + 0.1 × active_factors) × (0.5 + 0.5 × data_quality)
 *
 * — confidence rises with how many independent signals agree, and with how
 * complete the underlying data was. Ours keeps that shape and fixes two things
 * about it:
 *
 *   1. `0.4 + 0.1 × active_factors` reaches 1.0 only at exactly six factors and
 *      exceeds it beyond that. Ours normalises by the number of factors the
 *      detector declares, so full agreement is 1.0 whether a detector has two
 *      independent tests or five. At six factors the two expressions are the
 *      same function.
 *   2. `active_factors` is an integer count, which cannot express "cleared the
 *      threshold by 4×" — one of the things the number most needs to move with.
 *      A factor here contributes a *strength* in [0, 1], so a margin, a sample
 *      size and a cohort size are all expressible; a binary factor is just one
 *      that only ever contributes 0 or 1, which recovers the reference exactly.
 *
 * WHAT `ceiling` IS, and why the literals live on in it. `score_factor` in the
 * reference is the risk score. Ours is the detector's old constant: the
 * confidence its evidence can reach when every factor agrees and the read was
 * complete. Keeping it means the TOP of each detector's range is exactly the
 * number that detector always reported, so every change this file causes is
 * downward, from a best case that used to be claimed unconditionally to one
 * that now has to be earned. Nothing gets more confident than it was.
 *
 * WHAT THIS FILE MUST NOT DO. It has no say in whether a signal is raised.
 * Thresholds and severity mappings live in the detectors and are untouched:
 * confidence is a statement ABOUT an accusation, never part of making one.
 * A detector that computes a confidence of 12 still files the signal.
 *
 * Pure and total (no throw, no I/O) so it is unit-testable without Prisma or
 * the Remnawave panel.
 */

/**
 * The multiplier applied when NO factor agrees — the reference's `0.4`.
 *
 * Not zero, and deliberately: a detector only reaches this file after its own
 * threshold has been crossed, so "every factor at its weakest" still means
 * "the condition was detected". 0.4 keeps that worth showing an operator while
 * leaving most of the range to evidence that actually accumulated.
 */
const AGREEMENT_FLOOR = 0.4;

/** The multiplier applied when the read behind the signal was worthless — the reference's `0.5`. */
const QUALITY_FLOOR = 0.5;

/**
 * Hard floor on what is written to `FraudSignal.confidence`.
 *
 * The column is an integer percentage and the SPA renders it verbatim as
 * `{confidence}%`. `0%` reads as "this is certainly not fraud", which is the
 * opposite of what a fired detector means, so the product is never allowed to
 * round into it. Set below every detector's reachable minimum
 * (`ceiling × 0.4 × 0.5` is 11 at the lowest ceiling in the module) so it is a
 * guard against a future ceiling, not a shaper of the current distribution.
 */
const MIN_CONFIDENCE = 5;

/** One independent piece of evidence behind a signal. */
export interface ConfidenceFactor {
  /** Metadata key. Stable — operators and tests read it. */
  readonly name: string;
  /** The raw measured input, recorded so the number can be re-derived by hand. */
  readonly observed: number;
  /** How far this factor got from "barely there" (0) to "conclusive" (1). */
  readonly strength: number;
}

export interface ConfidenceInput {
  /**
   * Best case for this detector, on a 0–100 scale — the literal the detector
   * used to report unconditionally. The result never exceeds it.
   */
  readonly ceiling: number;
  /**
   * The independent factors this detector claims to weigh. Order is irrelevant;
   * names must be unique. An empty list means "no evidence is being weighed",
   * which is treated as full agreement — a detector with nothing to weigh gets
   * its ceiling rather than a silently invented penalty.
   */
  readonly factors: readonly ConfidenceFactor[];
  /**
   * Completeness of the read the signal rests on, in [0, 1]. `1` = we saw
   * everything we asked for; below that, the detector is judging on a prefix
   * of the data and says so.
   */
  readonly dataQuality: number;
}

export interface ConfidenceResult {
  /** Integer in `[MIN_CONFIDENCE, ceiling]`. */
  readonly confidence: number;
  /**
   * Every input, ready to be spread into a signal's `metadata` so an operator
   * can see why the number is what it is without reading this file.
   */
  readonly explanation: Readonly<Record<string, unknown>>;
}

/**
 * Linear ramp from "the threshold was barely cleared" to "conclusively".
 *
 * `value <= atFloor` → 0, `value >= atFull` → 1, linear between. A
 * non-finite value (a division by a zero denominator, a missing count) is the
 * weakest reading, never the strongest — an input we could not measure must not
 * be able to raise an accusation's confidence.
 */
export function ratioStrength(value: number, atFloor: number, atFull: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(atFloor) || !Number.isFinite(atFull) || atFull <= atFloor) {
    return value >= atFull ? 1 : 0;
  }
  if (value <= atFloor) return 0;
  if (value >= atFull) return 1;
  return (value - atFloor) / (atFull - atFloor);
}

/**
 * `ceiling × agreement × quality`, rounded and clamped.
 *
 *   agreement = 0.4 + 0.6 × (mean factor strength)
 *   quality   = 0.5 + 0.5 × dataQuality
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const ceiling = clamp(Math.round(input.ceiling), MIN_CONFIDENCE, 100);
  const factors = input.factors;

  const meanStrength =
    factors.length === 0
      ? 1
      : factors.reduce((sum, f) => sum + clamp01(f.strength), 0) / factors.length;
  const agreement = AGREEMENT_FLOOR + (1 - AGREEMENT_FLOOR) * meanStrength;
  const quality = QUALITY_FLOOR + (1 - QUALITY_FLOOR) * clamp01(input.dataQuality);

  const confidence = clamp(Math.round(ceiling * agreement * quality), MIN_CONFIDENCE, ceiling);

  const factorDetail: Record<string, { observed: number; strength: number }> = {};
  for (const factor of factors) {
    factorDetail[factor.name] = {
      observed: round2(factor.observed),
      strength: round2(clamp01(factor.strength)),
    };
  }

  return {
    confidence,
    explanation: {
      confidenceCeiling: ceiling,
      confidenceAgreement: round2(agreement),
      confidenceDataQuality: round2(clamp01(input.dataQuality)),
      confidenceFactors: factorDetail,
    },
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Two decimals is enough to re-derive the product by hand and keeps the JSON small. */
function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}
