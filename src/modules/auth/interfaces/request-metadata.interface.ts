/**
 * Describes normalized request metadata used by auth flows.
 */
export interface RequestMetadataInterface {
  readonly requestId: string | null;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;
}
