import { IsIn, IsOptional } from 'class-validator';

import { ONLINE_RANGE_KEYS, type OnlineRange } from '../services/remnawave-metrics-collector.service';

/**
 * Query DTO for the dashboard's online card — `GET admin/remnawave/metrics/
 * online-overview` and `…/online-distribution`.
 *
 * A class and not a hand-parsed `@Query('range')`, so that the global
 * `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`, `main.ts`) sees the
 * WHOLE query. The hand parser read one key and let everything else through:
 * `?hours=168` — the old route's parameter, still in any bookmarked URL or
 * script — answered 200 with the default window, as if it had been honoured.
 *
 * `range` is optional (the card's default is 24 hours) and otherwise exactly
 * one of the two windows. A repeated key (`?range=7d&range=24h`) arrives as an
 * array and is refused with the rest: it is not a window.
 */
export class OnlineRangeQueryDto {
  @IsOptional()
  @IsIn(ONLINE_RANGE_KEYS)
  public readonly range?: OnlineRange;
}
