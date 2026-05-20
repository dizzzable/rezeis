/**
 * Audit v2 projection — matches the contract the frontend
 * `audit-page.tsx` was already wired against (kind / actorId / payload /
 * targetType / cursor pagination).
 *
 * Mapping rules from `AdminAuditLog`:
 *   - `kind`        ← `action`
 *   - `actorId`     ← `adminUserId` (or `'system'` if null and ipAddress='system')
 *   - `actorIp`     ← `ipAddress`
 *   - `targetType`  ← `metadata.targetType` (when emitter sets it)
 *   - `targetId`    ← `metadata.targetId`   (when emitter sets it)
 *   - `payload`     ← `metadata` minus `targetType`/`targetId`
 */
export interface AuditEventV2Interface {
  readonly id: string;
  readonly kind: string;
  readonly actorId: string | null;
  readonly actorIp: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly payload: Record<string, unknown> | null;
  readonly createdAt: string;
}

export interface AuditEventListV2Result {
  readonly items: readonly AuditEventV2Interface[];
  readonly nextCursor: string | null;
}

/** Distinct values surfaced in the filter dropdowns. */
export interface AuditFacetsInterface {
  readonly kinds: readonly string[];
  readonly actors: readonly string[];
  readonly targetTypes: readonly string[];
}
