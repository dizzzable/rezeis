import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ReplayPaymentWebhookEventDto {
  @IsString()
  @MinLength(3)
  @MaxLength(512)
  public reason!: string;

  /**
   * Replay the event even when the inbox already considers it handled.
   *
   * This is a `@Body()` field, so a JSON caller sends a real boolean and
   * `false` survives - but JSON is not the only way in. `main.ts` starts with
   * `bodyParser: false` and then registers BOTH parsers via
   * `configureBoundedBodyParsers`, including
   * `useBodyParser('urlencoded', ...)`. A form-encoded
   * `reason=...&force=false` therefore arrives as the STRING `'false'`, and
   * under the previous `@Type(() => Boolean)` that is `Boolean('false')` ===
   * `true`: a caller explicitly declining to force got a forced replay of a
   * payment webhook. Same explicit transform as the query flags, so the two
   * content types cannot disagree about what `false` means.
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
  public force?: boolean;
}
