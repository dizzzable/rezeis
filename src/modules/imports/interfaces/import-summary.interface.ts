/**
 * Common import summary shape returned by all importer services.
 */
export interface ImportSummary {
  readonly importRecordId: string;
  readonly fetched: number;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly subscriptionsCreated: number;
  readonly subscriptionsUpdated: number;
  readonly errors: readonly string[];
}

export interface ImportRunInput {
  readonly mode: 'import' | 'sync';
  readonly createdBy: string | null;
  readonly data: unknown;
}
