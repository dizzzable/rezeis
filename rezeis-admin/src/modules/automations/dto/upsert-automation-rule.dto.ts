import { AutomationTriggerKind } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Single action declaration. The `params` object is intentionally typed
 * as `Record<string, unknown>`: every action handler validates its own
 * slice in `automation/actions/*-action-handler.ts`. Validating it
 * statically here would couple the DTO to the action catalog.
 */
export class AutomationActionDto {
  @IsString()
  @Length(1, 64)
  type!: string;

  @IsObject()
  params!: Record<string, unknown>;
}

export class UpsertAutomationRuleDto {
  @IsString()
  @Length(1, 96)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 512)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsEnum(AutomationTriggerKind)
  triggerKind!: AutomationTriggerKind;

  /**
   * Trigger spec.
   *
   *   REALTIME --> event-type pattern, e.g. "payment.failed" or "fraud.*".
   *   CRON     --> cron expression accepted by cron-parser
   *                (5 fields: minute, hour, day-of-month, month, day-of-week).
   *   MANUAL   --> empty string.
   *
   * Validation of the value vs `triggerKind` happens server-side in the
   * service so we can short-circuit on the empty MANUAL case.
   */
  @IsString()
  @Length(0, 256)
  triggerSpec!: string;

  /**
   * Optional condition tree (JSON-logic-ish). The evaluator in
   * `automation/utils/expression-evaluator.ts` is total — typos collapse
   * to `false` rather than throwing, but we still reject obviously
   * malformed input here as a UX courtesy.
   */
  @IsOptional()
  conditions?: unknown;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AutomationActionDto)
  actions!: AutomationActionDto[];
}
