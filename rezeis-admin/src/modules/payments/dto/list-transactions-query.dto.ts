import { PaymentGatewayType, PurchaseType, TransactionStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Every shape a User, Subscription or Transaction id can have in this schema.
 *
 *   - cuid — `@default(cuid())`, what every row has been given since the
 *     schema was rebased on 21.05.2026 (commit 34205982, migration `_init`).
 *     25 characters, lower case, starting with `c`.
 *   - UUID — `@default(uuid())`, what the baseline schema before that gave
 *     them. Rows written by it keep that id.
 *
 * `userId` used to be `@IsUUID('4')`, which fits only the second: every
 * current user id came back 400, so a "payments of this client" link could not
 * work for anybody created in the last four months.
 *
 * Case-sensitive on purpose. Postgres compares ids exactly, so an upper-cased
 * copy matches no row; refusing it names the mistake instead of answering with
 * an empty list that looks like "this customer never paid".
 */
const ROW_ID_PATTERN =
  /^(?:c[a-z0-9]{20,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Longest payment reference `q` takes. Provider ids run to ~60 characters. */
export const PAYMENT_REFERENCE_MAX_LENGTH = 200;

/**
 * Longest `userSearch` taken: 254 characters, the longest e-mail address SMTP
 * can carry — the longest of the four things it matches (a Telegram id, a user
 * id, an e-mail, a username). It had no cap at all.
 */
export const USER_SEARCH_MAX_LENGTH = 254;

/**
 * No control characters. A reference pasted out of a chat or a PDF can carry
 * them, and such a value is not a typo of a real reference but a different
 * string — refused by name rather than searched for and not found.
 */
const NO_CONTROL_CHARACTERS = /^\P{Cc}*$/u;

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ListTransactionsQueryDto {
  @IsOptional()
  @IsString()
  @Matches(ROW_ID_PATTERN, { message: 'userId must be a user id (a cuid, or a UUID on older rows)' })
  public userId?: string;

  /**
   * Payments of one subscription: those that name it directly and the
   * combined renewals that carry it as a line item (their own
   * `subscriptionId` is null).
   */
  @IsOptional()
  @IsString()
  @Matches(ROW_ID_PATTERN, {
    message: 'subscriptionId must be a subscription id (a cuid, or a UUID on older rows)',
  })
  public subscriptionId?: string;

  /**
   * One payment reference, matched EXACTLY against our `paymentId`, the
   * provider's `gatewayId` and the record `id` — whichever the operator has
   * in hand. Exact, not `contains`, because exact is what the indexes can
   * answer: `payment_id` is unique, `gateway_id` is indexed (20260918120000)
   * and `id` is the key, so the three branches are index lookups. A substring
   * match would scan the whole table on every pause in typing; that is what
   * Cmd+K already pays for. A bare number also matches an imported payment
   * under its importer's namespace (`bedolaga:4821` for `4821`), the form the
   * cabinet shows it in.
   *
   * An empty or blank value is refused rather than read as "no filter": the
   * panel omits the key when there is nothing to search, so an empty one is a
   * broken link, and answering it with every payment would hide that.
   */
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MinLength(1, { message: 'q must not be empty; leave it out to list every payment' })
  @MaxLength(PAYMENT_REFERENCE_MAX_LENGTH)
  @Matches(NO_CONTROL_CHARACTERS, { message: 'q must not contain control characters' })
  public q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(USER_SEARCH_MAX_LENGTH)
  public userSearch?: string;

  @IsOptional()
  @IsEnum(TransactionStatus)
  public status?: TransactionStatus;

  @IsOptional()
  @IsEnum(PaymentGatewayType)
  public gatewayType?: PaymentGatewayType;

  @IsOptional()
  @IsEnum(PurchaseType)
  public purchaseType?: PurchaseType;

  @IsOptional()
  @IsDateString()
  public dateFrom?: string;

  @IsOptional()
  @IsDateString()
  public dateTo?: string;

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
