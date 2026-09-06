import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { SubscriberServersInterface } from '../../remnawave/interfaces/subscriber-server.interface';
import { SubscriberServersService } from '../../remnawave/services/subscriber-servers.service';
import { buildUserReferenceWhere } from '../utils/user-reference.util';

/**
 * The servers behind one subscription, for the cabinet's globe.
 *
 * Reiwa calls this when a customer double-taps their subscription card. The
 * response is deliberately narrow — see `SubscriberServerInterface` for what is
 * in it and, more to the point, what is not: no address, no port, no node name,
 * no IP. A customer sees places and states, which is what they asked about.
 *
 * WHY A SUBSCRIPTION AND NOT A USER. Squads are assigned per subscription, by
 * its plan. A user with two subscriptions can reach two different sets of
 * servers, and the card they tapped is the one they are asking about. Taking
 * the subscription in the path rather than guessing the "current" one is what
 * makes the answer match the card.
 *
 * Failure is quiet by design. A panel that cannot be reached, a subscription
 * with no squads, a squad with no hosts — all return an empty list, because
 * this screen sits on top of a subscription that is working regardless, and an
 * error here would be the only thing wrong with it.
 */
@Controller('internal/user')
@UseGuards(InternalAdminAuthGuard)
export class InternalUserServersController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly subscriberServersService: SubscriberServersService,
  ) {}

  @Get(':userRef/subscriptions/:subscriptionId/servers')
  public async listServers(
    @Param('userRef') userRef: string,
    @Param('subscriptionId') subscriptionId: string,
  ): Promise<SubscriberServersInterface> {
    const user = await this.prismaService.user.findFirst({
      where: buildUserReferenceWhere(userRef),
      select: { id: true },
    });
    // The one loud failure: an unknown user is a caller bug, not a customer
    // with nothing to show, and silently answering "no servers" would hide it.
    if (!user) throw new NotFoundException('User not found');

    return this.subscriberServersService.getForSubscription(user.id, subscriptionId);
  }
}
