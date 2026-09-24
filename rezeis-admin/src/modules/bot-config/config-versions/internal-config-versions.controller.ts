import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { ConfigDeliveryState } from './config-delivery-state';
import {
  CONFIG_VERSION_KEYS,
  isConfigVersionConsumer,
  type ConfigVersionConsumer,
  type ConfigVersionKey,
} from './config-versions.constants';
import { ConfigVersionsService, type ConfigVersions } from './config-versions.service';

/** A version as the cabinet computes it: 32 hex digits. Anything else is not one. */
const VERSION_PATTERN = /^[0-9a-f]{32}$/;

interface ConfigVersionsPoll {
  readonly consumer: ConfigVersionConsumer;
  readonly held: Partial<Record<ConfigVersionKey, string | null>>;
}

/**
 * The cabinet's report out of the request body, or `null` when there is none
 * worth keeping. Lenient on purpose: a poll must never fail on its report — a
 * newer cabinet may send groups this panel does not know, which are dropped,
 * and a malformed body still gets the versions back.
 */
export function readConfigVersionsPoll(body: unknown): ConfigVersionsPoll | null {
  if (typeof body !== 'object' || body === null) return null;
  const { consumer, held } = body as { consumer?: unknown; held?: unknown };
  if (!isConfigVersionConsumer(consumer)) return null;
  if (typeof held !== 'object' || held === null || Array.isArray(held)) return null;
  const kept: Partial<Record<ConfigVersionKey, string | null>> = {};
  for (const key of CONFIG_VERSION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(held, key)) continue;
    const value = (held as Record<string, unknown>)[key];
    if (value === null || (typeof value === 'string' && VERSION_PATTERN.test(value))) kept[key] = value;
  }
  return { consumer, held: kept };
}

/**
 * InternalConfigVersionsController
 * ────────────────────────────────
 * `POST /api/internal/config-versions` — the cabinet's version poll.
 *
 * Every ~20 s each cabinet process (the API and the bot) sends which version of
 * each settings group it holds and gets back the current version of every
 * group (`ConfigVersionsService`); it re-reads the groups that differ. That is
 * the safety net under the "drop your cache" webhook: a lost hint, a panel
 * boot with new defaults, a backup restore — each reaches the cabinet within a
 * poll instead of a TTL.
 *
 * The report is kept (`ConfigDeliveryState`) for the delivery check: two
 * minutes after a save, a process still holding the old version is what raises
 * the operator's card.
 *
 * Response: `{ versions: { <group>: <32 hex> } }`. A group whose payload cannot
 * be read right now is absent, never guessed.
 *
 * Auth: `InternalAdminAuthGuard`, the api_token and signature every internal
 * route the cabinet calls uses.
 */
@ApiTags('internal/config-versions')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/config-versions')
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalConfigVersionsController {
  public constructor(
    private readonly versions: ConfigVersionsService,
    private readonly state: ConfigDeliveryState,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Current version of each settings group the cabinet copies; takes what it holds' })
  public async poll(@Body() body: unknown): Promise<{ readonly versions: ConfigVersions }> {
    const report = readConfigVersionsPoll(body);
    if (report !== null) {
      await this.state.recordReport(report.consumer, { held: report.held, reportedAt: Date.now() });
    }
    return { versions: await this.versions.current() };
  }
}
