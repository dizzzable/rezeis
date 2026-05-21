/**
 * Read-only projection of an audit log row exposed to the operator UI.
 *
 * Sensitive metadata fields are passed through as-is; callers that emit audit
 * rows are responsible for redacting secrets before they reach the database.
 */
export interface AdminAuditActorInterface {
  readonly id: string;
  readonly login: string;
  readonly email: string | null;
  readonly name: string | null;
}

export interface AdminAuditEventInterface {
  readonly id: string;
  readonly action: string;
  readonly actor: AdminAuditActorInterface | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}
