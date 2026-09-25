import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildAdminAuditLogData } from '../../../common/utils/admin-audit-log.util';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import { SettingsService } from '../../settings/services/settings.service';
import { mutateSettingsRow } from '../../settings/utils/settings-row-write.util';
import {
  type AddOnRolloutFlagReader,
  type AddOnRolloutFlags,
  type AddOnSwitchChanges,
  type AddOnSwitchState,
  describeAddOnSwitches,
  planAddOnSwitchUpdate,
  readStoredAddOnSwitches,
  readStoredRemnawaveTimeZone,
  resolveAddOnRolloutFlags,
  type StoredAddOnSwitches,
} from '../add-on-rollout.config';
import {
  ADD_ON_TIME_ZONE_INVALID,
  describeRemnawaveTimeZone,
  normalizeRemnawaveTimeZoneInput,
  REMNAWAVE_TIME_ZONE_KEY,
  RemnawaveTimeZoneInputError,
  type RemnawaveTimeZoneState,
} from './remnawave-time-zone';
import { judgeResetSchedule, readResetObservations, type ResetScheduleVerdict } from './reset-schedule-check';

/** What the page reads: the three switches, in the order it draws them, and the zone beside them. */
export interface AddOnSwitchesView {
  readonly switches: readonly AddOnSwitchState[];
  /** «Часовой пояс Remnawave». */
  readonly remnawaveTimeZone: RemnawaveTimeZoneState;
  /**
   * Do Remnawave's observed resets agree with that zone (`reset-schedule-check.ts`),
   * judged now; `null` when it could not be judged (the read failed).
   */
  readonly resetScheduleCheck: ResetScheduleVerdict | null;
}

/** Why a change was refused, as the page's toast names it. */
export const ADD_ON_SWITCH_SET_IN_ENV = 'ADD_ON_SWITCH_SET_IN_ENV';
export const ADD_ON_SWITCH_OFF_NOT_CONFIRMED = 'ADD_ON_SWITCH_OFF_NOT_CONFIRMED';

/**
 * The `addOnSettings` column after a save: WHAT IT HELD, the switches as
 * planned over it, and the zone as asked — a merge, never a replacement.
 *
 * The column carries more than the switches: «Часовой пояс Remnawave» lives
 * beside them (`remnawave-time-zone.ts`), and `planAddOnSwitchUpdate` plans
 * the switches alone. Writing its plan as the whole column — which is what this
 * did while the switches were all the column held — would erase the zone on
 * every switch save, and a zone save built the same way would erase the
 * switches. `zone`: `undefined` leaves the stored zone as it is, `null` removes
 * it (back to UTC), a string is the new zone.
 */
export function mergeAddOnSettings(
  raw: unknown,
  switches: StoredAddOnSwitches,
  zone: string | null | undefined,
): Record<string, unknown> {
  const held =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const next: Record<string, unknown> = { ...held, ...switches };
  if (zone === null) delete next[REMNAWAVE_TIME_ZONE_KEY];
  else if (zone !== undefined) next[REMNAWAVE_TIME_ZONE_KEY] = zone;
  return next;
}

/**
 * THE SWITCHES OF THE DURABLE ADD-ON MODEL, as both processes read them — and
 * «Часовой пояс Remnawave», which is stored and read with them.
 *
 * `flags()` is the only way the running panel learns what a stage is: the
 * stored switches through `SettingsService`'s row cache, the defaults under
 * them, and any explicit `.env` line over them (`add-on-rollout.config.ts`).
 * A switch saved on the page therefore reaches this process at once — the save
 * bumps the settings-write generation — and the other process within the row
 * cache's five seconds. No restart, no pub/sub, no second cache. The zone
 * rides in the same snapshot (`AddOnRolloutFlags.remnawaveTimeZone`), read from
 * the same row read, so an operation that read the flags once before its
 * transaction has the zone from that one read (review R2b-07).
 *
 * `update()` is the page's only write, through `mutateSettingsRow`: the change
 * is decided against the row as it stands under the lock, so an unconfirmed
 * switch-off cannot slip through between two operators' saves, and a switch
 * save and a zone save made at once both land (`mergeAddOnSettings`).
 */
@Injectable()
export class AddOnSwitchesService implements AddOnRolloutFlagReader {
  private readonly logger = new Logger(AddOnSwitchesService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly settingsService: SettingsService,
  ) {}

  public async flags(): Promise<AddOnRolloutFlags> {
    const stored = await this.settingsService.getStoredAddOnSettings();
    return resolveAddOnRolloutFlags(readStoredAddOnSwitches(stored), process.env, {
      remnawaveTimeZone: readStoredRemnawaveTimeZone(stored),
    });
  }

  public async view(now: Date = new Date()): Promise<AddOnSwitchesView> {
    const stored = await this.settingsService.getStoredAddOnSettings();
    const zone = readStoredRemnawaveTimeZone(stored) ?? null;
    return {
      switches: describeAddOnSwitches(readStoredAddOnSwitches(stored)),
      remnawaveTimeZone: describeRemnawaveTimeZone(zone),
      resetScheduleCheck: await this.resetScheduleCheck(zone, now),
    };
  }

  /**
   * The daily check's verdict, judged now against the zone as stored — so the
   * warning beside the field goes the moment the zone is corrected. Best-effort:
   * the switches must load whatever becomes of this read.
   */
  private async resetScheduleCheck(zone: string | null, now: Date): Promise<ResetScheduleVerdict | null> {
    try {
      const { observations, resetScoped } = await readResetObservations(this.prismaService, now);
      return judgeResetSchedule({ observations, timeZone: zone ?? undefined, resetScoped, now });
    } catch (error: unknown) {
      this.logger.warn(
        `Remnawave reset-schedule verdict not read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  public async update(input: {
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
    readonly changes: AddOnSwitchChanges;
    readonly confirmOff: boolean;
    /**
     * «Часовой пояс Remnawave» as the operator typed it: `''` puts it back to
     * UTC, `undefined` leaves it alone.
     */
    readonly remnawaveTimeZone?: string;
  }): Promise<AddOnSwitchesView> {
    // Decided before the lock: a zone this runtime does not know is refused
    // whole, and nothing of the request — no switch either — is written.
    const zone = input.remnawaveTimeZone === undefined ? undefined : this.normalizeZone(input.remnawaveTimeZone);
    const changed = await mutateSettingsRow(this.prismaService, async ({ tx, row, write }) => {
      const stored = readStoredAddOnSwitches(row.addOnSettings);
      const plan = planAddOnSwitchUpdate({ stored, changes: input.changes, confirmOff: input.confirmOff });
      if (plan.kind === 'SET_IN_ENV') {
        throw new ConflictException({
          code: ADD_ON_SWITCH_SET_IN_ENV,
          message: `The switch is decided by ${plan.variables.join(', ')} in .env; remove the line to manage it here`,
          switch: plan.switchName,
          variables: [...plan.variables],
        });
      }
      if (plan.kind === 'OFF_NOT_CONFIRMED') {
        throw new BadRequestException({
          code: ADD_ON_SWITCH_OFF_NOT_CONFIRMED,
          message: 'Switching this off has to be confirmed (confirmOff: true)',
          switch: plan.switchName,
        });
      }
      const moved: Record<string, boolean | string | null> = Object.fromEntries(
        plan.changed.map((name) => [name, plan.next[name] ?? null]),
      );
      const zoneMoves = zone !== undefined && zone !== (readStoredRemnawaveTimeZone(row.addOnSettings) ?? null);
      if (zoneMoves) moved[REMNAWAVE_TIME_ZONE_KEY] = zone;
      if (Object.keys(moved).length === 0) return {};
      await write({
        addOnSettings: mergeAddOnSettings(row.addOnSettings, plan.next, zoneMoves ? zone : undefined) as Prisma.InputJsonObject,
      });
      await tx.adminAuditLog.create({
        data: buildAdminAuditLogData({
          action: 'settings.addOnSwitches.update',
          actorId: input.currentAdmin.id,
          requestMetadata: input.requestMetadata,
          metadata: { requestId: input.requestMetadata.requestId, changed: moved },
        }),
      });
      return moved;
    });
    if (Object.keys(changed).length > 0) {
      this.logger.log(`Add-on switches changed by admin ${input.currentAdmin.id}: ${JSON.stringify(changed)}`);
    }
    // Read back through the row cache, not from `written`: the view is what
    // `flags()` will now answer, `.env` included, and the write just bumped
    // the generation, so this read cannot be served the row from before it.
    return this.view();
  }

  private normalizeZone(input: string): string | null {
    try {
      return normalizeRemnawaveTimeZoneInput(input);
    } catch (error) {
      if (error instanceof RemnawaveTimeZoneInputError) {
        throw new BadRequestException({ code: ADD_ON_TIME_ZONE_INVALID, message: error.message });
      }
      throw error;
    }
  }
}
