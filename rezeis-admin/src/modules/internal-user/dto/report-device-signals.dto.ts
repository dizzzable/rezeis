import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Device signals the cabinet computed for one user.
 *
 * ── Both fields are optional and that is the normal case ──────────────────
 *
 * A browser that blocks canvas readback produces no `deviceHash`; a private
 * window produces no persistent `installId`. Requiring either would make the
 * endpoint fail for exactly the visitors most worth observing, and a failing
 * call is one the cabinet stops making.
 *
 * ── The length caps here are not the real validation ──────────────────────
 *
 * They exist so a hostile payload is rejected before it reaches the service,
 * which does the real normalisation (charset, minimum length, canonical case).
 * Keeping the substantive rules in one place is what stops the writer and the
 * reader disagreeing about what "the same device" means.
 */
export class ReportDeviceSignalsDto {
  @IsString()
  @MaxLength(64)
  public userId!: string;

  /**
   * A random value the cabinet persists in the browser. Exact while it lasts,
   * and gone the moment somebody clears site data.
   */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  public installId?: string;

  /**
   * A digest over what the graphics stack does. Survives a cleared profile and
   * usually a different browser on the same machine, and is NOT unique to a
   * person — two identical laptops produce the same value.
   */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  public deviceHash?: string;
}
