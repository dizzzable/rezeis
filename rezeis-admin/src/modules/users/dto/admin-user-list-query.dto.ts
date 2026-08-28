import { Locale, SubscriptionStatus, UserRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/**
 * Query DTO for `GET /admin/users`.
 *
 * Powers the left-hand list on the admin Users page. Supports:
 *   • `search` — free-text fragment matched against `id`, `telegramId`,
 *     `username`, `email`, `name`, `referralCode`, and the linked
 *     `WebAccount.login` (case-insensitive `contains`).
 *   • filters — every field below, combined with AND; multi-value fields are
 *     an OR within themselves.
 *   • `limit` / `offset` — bounded paging.
 *
 * ── How multi-value filters arrive ────────────────────────────────────────
 *
 * As a comma-separated string (`?roles=USER,ADMIN`), normalised to an array by
 * {@link toStringArray}. Express also parses repeated keys (`?roles=a&roles=b`)
 * into an array, and that shape is accepted too — a URL an operator shares must
 * work whichever way their client built it.
 *
 * An unknown member is DROPPED rather than rejected. A saved link outliving a
 * plan that was deleted should return the rest of the filter, not a validation
 * error the operator cannot act on; and `@IsEnum` on the array would refuse the
 * whole request over one stale id.
 */

function toStringArray(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const items = raw
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
  // An empty result reads as "no filter", never as "match nothing" — the second
  // would make `?roles=` return an empty list, which looks like a broken page.
  return items.length > 0 ? items : undefined;
}

/**
 * The members of `allowed` the caller asked for.
 *
 * ── AN UNKNOWN MEMBER MUST NOT WIDEN THE QUERY ────────────────────────────
 *
 * This used to answer `undefined` — "no filter" — when nothing survived the
 * check, which is the same value an ABSENT parameter produces. So `?roles=`
 * and `?roles=SUPERADMIN` meant the same thing, and the second returned EVERY
 * user while the page's own badge still counted the filter as applied. An
 * operator looking at "1 filter" over an unfiltered list is the exact failure
 * the filter module says it exists to prevent, and a shared or hand-edited URL
 * is all it takes.
 *
 * The two cases are now told apart. Nothing asked for is no filter; something
 * asked for that cannot match anything is an EMPTY list, which Prisma renders
 * as `IN ()` — no rows. That is the honest answer to "show me the SUPERADMINs".
 */
function toEnumArray<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  const items = toStringArray(value);
  if (items === undefined) return undefined;
  return items.filter((entry): entry is T => (allowed as readonly string[]).includes(entry));
}

/**
 * `?flag=false` is the string "false", which is truthy.
 *
 * This is the trap that has bitten this codebase before: a bare `Boolean(value)`
 * turns every explicit `false` in a query string into `true`, so a filter for
 * "not blocked" quietly returns the blocked ones.
 */
function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

export class AdminUserListQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 128)
  public search?: string;

  /** Any non-deleted subscription whose plan snapshot names one of these ids. */
  @IsOptional()
  @Transform(({ value }) => toStringArray(value))
  @IsArray()
  @IsString({ each: true })
  public planIds?: string[];

  @IsOptional()
  @Transform(({ value }) => toEnumArray(value, Object.values(SubscriptionStatus)))
  @IsArray()
  @IsEnum(SubscriptionStatus, { each: true })
  public subscriptionStatuses?: SubscriptionStatus[];

  @IsOptional()
  @Transform(({ value }) => toEnumArray(value, Object.values(UserRole)))
  @IsArray()
  @IsEnum(UserRole, { each: true })
  public roles?: UserRole[];

  @IsOptional()
  @Transform(({ value }) => toEnumArray(value, Object.values(Locale)))
  @IsArray()
  @IsEnum(Locale, { each: true })
  public languages?: Locale[];

  /** `true` = has at least one non-deleted subscription; `false` = has none. */
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  public hasSubscription?: boolean;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  public isTrial?: boolean;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  public isBlocked?: boolean;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  public hasTelegram?: boolean;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  public hasWebAccount?: boolean;

  /** Accounts carrying at least one unresolved review flag. */
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  public flagged?: boolean;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  public createdFrom?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  public createdTo?: Date;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  public limit?: number;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  public offset?: number;
}
