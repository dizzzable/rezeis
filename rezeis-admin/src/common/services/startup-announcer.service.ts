import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { getProcessRole, shouldRunSchedules } from '../runtime/process-role.util';
import { EVENT_TYPES, SystemEventsService } from './system-events.service';

/**
 * «🚀 Запуск системы» — the card that says the panel came back up, and which
 * release it came back up on.
 *
 * The type has been registered, titled and tick-boxed since long before this
 * file; nothing raised it. It is worth raising because the card's build block
 * is filled in automatically from the image (version, commit, branch), so one
 * card after a deploy answers the question an operator actually has — «что
 * сейчас работает» — without opening anything.
 *
 * ONE CARD PER DEPLOY, NOT ONE PER CONTAINER. The same application boots as
 * the API and as the worker, so announcing from both would print two identical
 * cards for every restart of a split deployment. The announcement follows the
 * schedule role (`worker`/`all`), which is the rule every other once-per-install
 * job in this codebase already follows, and the role is named in the metadata
 * so a reader can tell which container reported. An `api`-only container
 * restarting is deliberately silent.
 *
 * `OnApplicationBootstrap`, not `onModuleInit`: by then every module is wired,
 * so the card cannot be raised by a process that is still about to fail its
 * own startup.
 */
@Injectable()
export class StartupAnnouncerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupAnnouncerService.name);

  public constructor(private readonly systemEvents: SystemEventsService) {}

  public onApplicationBootstrap(): void {
    if (!shouldRunSchedules()) return;
    const role = getProcessRole();
    // Never throws into the bootstrap: a card that cannot be sent must not
    // stop the panel from starting. `emit` already swallows every delivery
    // failure of its own, so this only covers the unexpected.
    try {
      this.systemEvents.info(EVENT_TYPES.SYSTEM_STARTUP, 'SYSTEM', `Панель запущена (${role})`, {
        role,
        startedAt: new Date().toISOString(),
      });
    } catch (error: unknown) {
      this.logger.warn(
        `Startup card was not raised: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
