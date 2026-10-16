import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { buildUserReferenceWhere } from '../../internal-user/utils/user-reference.util';
import { storedIdentityOf } from '../../remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';

/**
 * `GET /api/internal/user/:userRef/subscriptions/:subscriptionId/connection`.
 *
 * `known` only when Remnawave answered with a traffic block this panel could
 * read; the two instants are then exactly what Remnawave said. `unknown` is
 * every other answer — no profile, an outage, a block that did not decode —
 * and never a softer "not connected".
 *
 * `checkedAt` is THIS panel's clock at the read. The cabinet compares
 * `onlineAt` against it rather than against the phone's clock, which can be
 * minutes out and would turn a connection into "not yet" or the reverse.
 */
export interface SubscriptionConnectionView {
  readonly state: 'known' | 'unknown';
  readonly onlineAt: string | null;
  readonly firstConnectedAt: string | null;
  readonly checkedAt: string;
}

/**
 * Whether one subscription's VPN profile is online — asked by the cabinet's
 * guided connect walk while the customer switches the VPN on.
 *
 * ── A live read, on purpose ──────────────────────────────────────────────
 *
 * The stored connection signal (`subscription_connect_state`) answers "has
 * this profile EVER connected", which is the wrong question here: a customer
 * putting the subscription on a second phone connected long ago. The walk
 * needs "did it come online just now", and only Remnawave's `onlineAt` says
 * that — so this reads the profile, one request per poll, and writes nothing.
 * The card read on the dashboard still records the evidence as before.
 *
 * Only the resolved customer's own, non-deleted subscription. An unknown
 * customer, an unknown subscription and someone else's subscription all answer
 * the same 404, so the route cannot be used to learn whose a subscription is.
 */
@Controller('internal/user')
@UseGuards(InternalAdminAuthGuard)
// NOT THROTTLED PER ADDRESS. Every call here comes from the cabinet’s
// backend — one address, on behalf of every customer at once — so the global
// 600/minute per-IP limit was 600 requests a minute for the whole customer
// base together, and past it the cabinet stopped working for everybody. The
// argument in full, including why a per-address limit protects nothing on a
// route behind `InternalAdminAuthGuard`, is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalSubscriptionConnectionController {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
  ) {}

  @Get(':userRef/subscriptions/:subscriptionId/connection')
  public async connection(
    @Param('userRef') userRef: string,
    @Param('subscriptionId') subscriptionId: string,
  ): Promise<SubscriptionConnectionView> {
    const user = await this.prismaService.user.findUnique({
      where: buildUserReferenceWhere(userRef),
      select: { id: true },
    });
    const subscription =
      user === null
        ? null
        : await this.prismaService.subscription.findFirst({
            where: {
              id: subscriptionId,
              userId: user.id,
              status: { not: SubscriptionStatus.DELETED },
            },
            select: {
              remnawaveId: true,
              remnawavePanelId: true,
              remnawavePanelUsername: true,
              configUrl: true,
            },
          });
    if (subscription === null) {
      throw new NotFoundException('Subscription not found');
    }
    return readConnection(this.remnawaveApiService, storedIdentityOf(subscription), new Date());
  }
}

/** The read itself, apart from the routing, so the answer can be tested without Nest. */
export async function readConnection(
  remnawave: Pick<RemnawaveApiService, 'getPanelUserUsage'>,
  identity: ReturnType<typeof storedIdentityOf>,
  now: Date,
): Promise<SubscriptionConnectionView> {
  const unknown: SubscriptionConnectionView = {
    state: 'unknown',
    onlineAt: null,
    firstConnectedAt: null,
    checkedAt: now.toISOString(),
  };
  if (identity === null) return unknown;
  const usage = await remnawave.getPanelUserUsage(identity);
  const traffic = usage?.userTraffic ?? null;
  if (traffic === null) return unknown;
  return {
    state: 'known',
    onlineAt: traffic.onlineAt,
    firstConnectedAt: traffic.firstConnectedAt,
    checkedAt: now.toISOString(),
  };
}
