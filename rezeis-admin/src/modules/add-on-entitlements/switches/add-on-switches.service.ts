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
  resolveAddOnRolloutFlags,
} from '../add-on-rollout.config';

/** What the page reads: the three switches, in the order it draws them. */
export interface AddOnSwitchesView {
  readonly switches: readonly AddOnSwitchState[];
}

/** Why a change was refused, as the page's toast names it. */
export const ADD_ON_SWITCH_SET_IN_ENV = 'ADD_ON_SWITCH_SET_IN_ENV';
export const ADD_ON_SWITCH_OFF_NOT_CONFIRMED = 'ADD_ON_SWITCH_OFF_NOT_CONFIRMED';

/**
 * THE SWITCHES OF THE DURABLE ADD-ON MODEL, as both processes read them.
 *
 * `flags()` is the only way the running panel learns what a stage is: the
 * stored switches through `SettingsService`'s row cache, the defaults under
 * them, and any explicit `.env` line over them (`add-on-rollout.config.ts`).
 * A switch saved on the page therefore reaches this process at once — the save
 * bumps the settings-write generation — and the other process within the row
 * cache's five seconds. No restart, no pub/sub, no second cache.
 *
 * `update()` is the page's only write, through `mutateSettingsRow`: the change
 * is decided against the row as it stands under the lock, so an unconfirmed
 * switch-off cannot slip through between two operators' saves.
 */
@Injectable()
export class AddOnSwitchesService implements AddOnRolloutFlagReader {
  private readonly logger = new Logger(AddOnSwitchesService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly settingsService: SettingsService,
  ) {}

  public async flags(): Promise<AddOnRolloutFlags> {
    return resolveAddOnRolloutFlags(await this.settingsService.getStoredAddOnSwitches());
  }

  public async view(): Promise<AddOnSwitchesView> {
    return { switches: describeAddOnSwitches(await this.settingsService.getStoredAddOnSwitches()) };
  }

  public async update(input: {
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
    readonly changes: AddOnSwitchChanges;
    readonly confirmOff: boolean;
  }): Promise<AddOnSwitchesView> {
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
      if (plan.changed.length === 0) return {};
      const moved = Object.fromEntries(plan.changed.map((name) => [name, plan.next[name] ?? null]));
      await write({ addOnSettings: { ...plan.next } as Prisma.InputJsonObject });
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
}
