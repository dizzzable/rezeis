/** Metadata for an uploaded quest icon asset (never carries the raw SVG). */
export interface QuestIconAssetInterface {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}
