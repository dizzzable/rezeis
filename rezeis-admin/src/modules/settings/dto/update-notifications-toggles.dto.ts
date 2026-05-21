import { IsObject, IsOptional } from 'class-validator';

/**
 * Patch payload for `PATCH /admin/settings/notifications`.
 *
 * The frontend `notifications` page submits two distinct toggle maps —
 * one for end-user delivery preferences (`userNotifications`) and one for
 * the operator-side firehose (`systemNotifications`). Either, both or
 * neither may be present. Each value is a `Record<string, boolean>` whose
 * keys are notification slugs (`expires_in_3_days`, `node_status`, …).
 *
 * The DTO leaves the inner shape opaque on purpose so that adding a new
 * notification kind in the frontend only requires extending the catalog
 * there, without a backend release.
 */
export class UpdateNotificationsTogglesDto {
  @IsOptional()
  @IsObject()
  public readonly userNotifications?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  public readonly systemNotifications?: Record<string, unknown>;
}
