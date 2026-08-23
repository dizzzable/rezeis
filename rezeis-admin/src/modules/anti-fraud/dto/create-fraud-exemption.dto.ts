import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Body for `POST /admin/fraud/exemptions`.
 *
 * Three fields are required that a looser design would have made optional, and
 * each omission is the failure mode it prevents:
 *
 *   `expiresAt` — a whitelist entry with no end date is a detector switched off
 *     for that user forever, and nobody ever goes back to look. Making the
 *     operator pick a date means the worst case is a renewal, not a blind spot.
 *     (`NOT NULL` on the column is the second, non-bypassable half of this.)
 *
 *   `codes` — a blanket exemption cannot be justified later. A power user whose
 *     device count is legitimately high has not been cleared of promocode abuse,
 *     and this is the field that says so. At least one, at most sixteen.
 *
 *   `reason` — in six months this sentence is the only thing separating a
 *     considered decision from somebody's mistake.
 */
export class CreateFraudExemptionDto {
  @IsString()
  @Length(1, 64)
  userId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  codes!: string[];

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  /** Must be in the future — the service re-checks it against its own clock. */
  @IsISO8601()
  expiresAt!: string;
}

/** Query DTO for `GET /admin/fraud/exemptions`. */
export class ListFraudExemptionsQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  userId?: string;

  /**
   * Defaults to false — an expired or revoked exemption is exactly what an
   * operator asking "why did we stop seeing signals for this user" needs to
   * find, so history is visible unless they ask for only the live ones.
   *
   * The coercion is spelled out rather than left to `@Type(() => Boolean)`,
   * which on a query string is plain `Boolean(string)`: every non-empty value
   * became `true`, `'false'` and `'0'` included. That direction is the bad one
   * HERE too, and worse than it looks - `activeOnly` narrows the result set
   * (`AntiFraudService`: `revokedAt: null, expiresAt: { gt: now }`), so an
   * "only show active" toggle sitting at its default OFF would have arrived
   * ON and HIDDEN exactly the revoked and expired entries described above. A
   * filter that silently inverts is worse than one that errors, so an
   * unrecognised value is passed through for `@IsBoolean()` to reject.
   * A valueless `?activeOnly=` asserts nothing and is treated as absence.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }): unknown => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (value === true || value === 'true' || value === '1') {
      return true;
    }
    if (value === false || value === 'false' || value === '0') {
      return false;
    }
    return value;
  })
  @IsBoolean()
  activeOnly?: boolean;
}
