/**
 * Whether a support message carries the AI assistant's mark — `{ "ai": true }`
 * in `metadata`.
 *
 * The assistant writes as ADMIN with this mark rather than as an author type
 * of its own, so a release that has never heard of it (a panel rolled back,
 * any cabinet) reads its replies as support replies instead of failing on an
 * enum value it does not know.
 */
export function isAiMessageMetadata(metadata: unknown): boolean {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>)['ai'] === true
  );
}
