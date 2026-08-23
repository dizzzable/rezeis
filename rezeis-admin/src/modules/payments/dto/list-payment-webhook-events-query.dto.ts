import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import {
  PaymentGatewayType,
  PaymentWebhookLifecycleStatus,
} from '@prisma/client';

export class ListPaymentWebhookEventsQueryDto {
  @IsOptional()
  @IsEnum(PaymentGatewayType)
  public gatewayType?: PaymentGatewayType;

  @IsOptional()
  @IsEnum(PaymentWebhookLifecycleStatus)
  public status?: PaymentWebhookLifecycleStatus;

  @IsOptional()
  @IsString()
  public paymentId?: string;

  @IsOptional()
  @IsString()
  public providerEventId?: string;

  @IsOptional()
  @IsISO8601()
  public from?: string;

  @IsOptional()
  @IsISO8601()
  public to?: string;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  public limit?: number;

  @IsOptional()
  @Type((): NumberConstructor => Number)
  @IsInt()
  @Min(0)
  @Max(2000)
  public offset?: number;
}

export class PaymentWebhookEventDetailQueryDto {
  /**
   * Return the webhook's raw provider payload.
   *
   * Off by default, and a reveal writes an audit entry
   * (`PaymentWebhookOpsService.auditPayloadReveal`), so this flag has to fail
   * CLOSED. It used to carry `@Type(() => Boolean)`, which on a query string is
   * plain JavaScript `Boolean(string)`: EVERY non-empty value coerced to
   * `true` — `'false'` and `'0'` included. A "hide raw payload" control wired
   * to that would have revealed the payload and logged an operator as having
   * revealed it, which is the one direction this flag must never fail in.
   *
   * Transformed explicitly instead, matching `ConfigExportQueryDto`. Only the
   * literal tokens are honoured; an unrecognised value is passed through
   * unchanged so `@IsBoolean()` rejects the request rather than guessing which
   * way the operator meant it. An empty value (`?includeRaw=`) asserts nothing
   * and is treated as absence — which is also what it already resolved to.
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
  public includeRaw?: boolean;
}

export class ReplayPaymentWebhookEventParamsDto {
  @IsUUID('4')
  public eventId!: string;
}
