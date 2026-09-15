import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Request shapes of the plan migration routes (`admin/plans/:planId/...`).
 *
 * ── Limit encodings on the wire ──────────────────────────────────────────────
 *
 * Every `trafficLimit` / `deviceLimit` these routes answer with is encoded
 * EXACTLY as the subscription columns and `GET /admin/subscriptions`:
 *
 *   trafficLimit   whole GiB, an integer or `null`; `null` = UNLIMITED and `0`
 *                  is a real, finite budget of zero;
 *   deviceLimit    an integer; any value `<= 0` = UNLIMITED (both `0` and `-1`
 *                  occur and mean the same).
 *
 * ── Machine codes ────────────────────────────────────────────────────────────
 *
 * Structural refusals below are class-validator's (400, no code). The
 * product refusals the dialog branches on — `EMPTY_ASSIGNMENT`, `TOO_MANY_IDS`,
 * `DUPLICATE_SUBSCRIPTION`, `TARGET_IS_SOURCE`, `TARGET_NOT_FOUND`,
 * `TARGET_IS_TRIAL`, and the 409 `MIGRATION_ALREADY_RUNNING` — are decided by
 * the service, so an array longer than the id limit is deliberately NOT capped
 * here: capped by a decorator it would lose its code.
 */

const ID_MAX_LENGTH = 64;

export class ListPlanMigrationSubscriptionsQueryDto {
  /** Name, username, e-mail, subscription id (substring, any case) or exact Telegram id. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public search?: string;

  /** Opaque, from the previous page's `nextCursor`. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  public cursor?: string;

  /** 1..200, default 50. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public limit?: number;
}

export class PlanMigrationGroupDto {
  @IsString()
  @Length(1, ID_MAX_LENGTH)
  public targetPlanId!: string;

  /** Each id at most once across ALL groups (`DUPLICATE_SUBSCRIPTION`). */
  @IsArray()
  @IsString({ each: true })
  @Length(1, ID_MAX_LENGTH, { each: true })
  public subscriptionIds!: string[];
}

/** `POST …/migrations` — who goes where. */
export class StartPlanMigrationDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PlanMigrationGroupDto)
  public groups?: PlanMigrationGroupDto[];

  /** Every OTHER subscription on the plan, resolved when the request is handled. */
  @IsOptional()
  @IsString()
  @Length(1, ID_MAX_LENGTH)
  public restTargetPlanId?: string | null;
}

/** `POST …/migrations/preview` — the same assignment, plus paging of `rows`. */
export class PreviewPlanMigrationDto extends StartPlanMigrationDto {
  /** The previous page's `nextCursor`. */
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX_LENGTH)
  public cursor?: string | null;

  /** Rows per page, 1..200, default 50. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public limit?: number;
}

export class GetPlanMigrationRunQueryDto {
  /** The previous page's `problemsCursor`. */
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX_LENGTH)
  public problemsCursor?: string;
}

export const PLAN_MIGRATION_RETRY_SCOPES = ['failed', 'sync'] as const;

export class RetryPlanMigrationDto {
  /** `failed`: FAILED items back to PENDING. `sync`: re-drive the run's FAILED sync jobs. */
  @IsIn(PLAN_MIGRATION_RETRY_SCOPES)
  public scope!: (typeof PLAN_MIGRATION_RETRY_SCOPES)[number];
}
