import { IsInt, NotEquals } from 'class-validator';

/**
 * Signed points adjustment. `@IsInt` rejects NaN / Infinity / non-integer /
 * string payloads that would otherwise flow into a Prisma `{ increment }` and
 * corrupt the balance (NaN passes a naive `< 0` guard). Zero is a no-op and
 * rejected so every adjustment is meaningful and auditable.
 */
export class AdjustUserPointsDto {
  @IsInt({ message: 'delta must be an integer' })
  @NotEquals(0, { message: 'delta must not be zero' })
  public delta!: number;
}
