import { Injectable, Logger, Optional } from '@nestjs/common';

import { RemnawaveApiService } from './remnawave-api.service';

/**
 * Our own nodes' addresses, grouped per node, or `null` when the panel could
 * not be asked.
 *
 * ── Why this is a service and not a private method ────────────────────────
 *
 * It had one caller (the block cascade), then two, and this file exists at the
 * moment there was about to be a third. The codebase already carries a note
 * about a duplicated node-flap check that "should be hoisted the next time
 * either is touched"; copying a decision like this a third time is how two
 * copies quietly stop agreeing about what counts as our own address.
 *
 * ── GROUPED PER NODE, not flattened, and that is the whole point ──────────
 *
 * A node reached by hostname contributes nothing comparable from its configured
 * address, and everything from the addresses it reports for itself — but the
 * panel only began reporting those in 3.2.3. On an older one such a node yields
 * an EMPTY group, and the classifier needs to see that emptiness to know it
 * could not rule the node out.
 *
 * Flattened into one list the emptiness is invisible: the list is non-empty
 * because other nodes filled it, the guard passes, and the node nobody could
 * compare against is exactly the one the customer was connected through.
 *
 * ── `null` is not `[]` ────────────────────────────────────────────────────
 *
 * `getAllNodes()` swallows every error and answers `[]`, so "we have no nodes"
 * and "we could not ask" arrive as one value. Everything downstream decides
 * whether to attribute an address to a person on that distinction, so it is
 * restored here: a throw, or no client at all, is `null`.
 */
@Injectable()
export class NodeAddressesService {
  private readonly logger = new Logger(NodeAddressesService.name);

  public constructor(
    @Optional() private readonly remnawaveApiService?: RemnawaveApiService,
  ) {}

  public async read(): Promise<readonly (readonly string[])[] | null> {
    if (this.remnawaveApiService === undefined) return null;
    try {
      const nodes = await this.remnawaveApiService.getAllNodes();
      return nodes.map((node) => [node.address, ...node.ips.map((entry) => entry.ip)]);
    } catch (err) {
      this.logger.warn(`Could not enumerate nodes: ${(err as Error).message}`);
      return null;
    }
  }
}
