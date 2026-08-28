import { ForbiddenException } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * Refuses to start a payment for a blocked account.
 *
 * ── Why the payment paths need their own check ───────────────────────────
 *
 * Blocking already refuses the session, the login and the bot, so in the
 * ordinary course a blocked person cannot reach a checkout screen at all. Two
 * things get past that anyway, and both were live:
 *
 * A DIRECT INTERNAL CALL. The internal API is reachable by anything holding the
 * shared key, which is the same reasoning that put the access-mode gate in
 * these services rather than only at the cabinet edge. A gate that exists on
 * one layer only is a gate somebody eventually walks around.
 *
 * AUTOPAY. The renewal scheduler charges a saved card with no session and no
 * screen — it reads subscriptions straight out of the table. Nothing about
 * being blocked stopped it, so a banned customer kept being charged for a VPN
 * the ban had just switched off. That one is not merely a hole; it is taking
 * money for a service we are deliberately refusing to provide, which is why
 * `AutoRenewService` excludes blocked owners in the QUERY rather than relying
 * on this refusal downstream: the cleanest outcome is that the charge is never
 * attempted, not that it fails.
 *
 * ── Why the refusal names the reason ─────────────────────────────────────
 *
 * Unlike the registration doors, which answer identically for every refusal so
 * the sign-up form is not an oracle, there is nothing to hide here: the caller
 * is already authenticated as this account, and the cabinet is already told
 * `USER_BLOCKED` when it reads the session. A vaguer code would only make the
 * support conversation harder.
 */
export async function assertPurchaserNotBlocked(
  prismaService: PrismaService,
  identity: { readonly userId?: string | null; readonly telegramId?: string | null },
): Promise<void> {
  const where = buildWhere(identity);
  // No resolvable identity is not this function's problem to report: the
  // caller's own resolution raises a far better error a few lines later, and
  // throwing here would replace "user not found" with "account is blocked".
  if (where === null) return;

  const user = await prismaService.user.findFirst({ where, select: { isBlocked: true } });
  if (user?.isBlocked === true) {
    throw new ForbiddenException({
      code: 'USER_BLOCKED',
      message: 'This account is blocked',
    });
  }
}

function buildWhere(identity: {
  readonly userId?: string | null;
  readonly telegramId?: string | null;
}): { readonly id: string } | { readonly telegramId: bigint } | null {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return { id: identity.userId };
  }
  const telegramId = identity.telegramId;
  // Guarded because `BigInt('abc')` throws, and a raw 500 out of a safety check
  // is worse than the request it was meant to refuse.
  if (typeof telegramId === 'string' && /^\d+$/.test(telegramId)) {
    return { telegramId: BigInt(telegramId) };
  }
  return null;
}
