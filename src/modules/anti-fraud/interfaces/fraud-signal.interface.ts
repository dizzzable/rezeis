import { FraudSignalSeverity, FraudSignalStatus } from '@prisma/client';

/**
 * Public projection of a `FraudSignal` row exposed to the admin UI.
 *
 * The shape stays intentionally close to the Prisma record so the UI can
 * read history, sort by score, and render resolution metadata without
 * extra round-trips. JSON `metadata` keeps the detector-specific payload
 * (counts, thresholds, time bucket).
 */
export interface FraudSignalInterface {
  readonly id: string;
  readonly code: string;
  readonly severity: FraudSignalSeverity;
  readonly status: FraudSignalStatus;
  readonly title: string;
  readonly description: string;
  readonly score: number;
  readonly confidence: number;
  readonly affectedUserIds: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly lastAction: string;
  readonly detectedAt: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly resolutionNote: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Detector output. Each anti-fraud detector runs and returns zero or more
 * candidate signals; the `AntiFraudOrchestrator` upserts them into the
 * database keyed by `(code, fingerprint)`.
 */
export interface FraudSignalCandidate {
  readonly code: string;
  /**
   * Detector-defined deduplication fingerprint. The orchestrator uses
   * `(code, fingerprint)` as the upsert key while the matching open
   * signal exists. Empty string means "always create a new row".
   */
  readonly fingerprint: string;
  readonly severity: FraudSignalSeverity;
  readonly title: string;
  readonly description: string;
  readonly score: number;
  readonly confidence: number;
  readonly affectedUserIds: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Action taken automatically when a candidate is upserted. */
export type FraudSignalAction =
  | 'none'
  | 'notify'
  | 'block_user'
  | 'freeze_subscription';

/** Listing query for the admin UI. */
export interface ListFraudSignalsQuery {
  readonly status?: FraudSignalStatus;
  readonly severity?: FraudSignalSeverity;
  readonly code?: string;
  readonly limit: number;
  readonly cursor: string | null;
}

export interface ListFraudSignalsResult {
  readonly items: readonly FraudSignalInterface[];
  readonly nextCursor: string | null;
}
