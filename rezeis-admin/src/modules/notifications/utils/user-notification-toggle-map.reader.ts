import type { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * The operator's `userNotifications` switches (`Settings.userNotifications`),
 * as stored: a key per notification type, `false` for one switched off. Read
 * where a decision needs them outside the delivery fanout — whether a type that
 * is off until the operator turns it on (`isDefaultOffNotificationType`) runs
 * at all, and whether the cabinet offers the subscriber its switch.
 *
 * Throws when the row cannot be read; each caller decides what that means.
 */
export async function readUserNotificationToggleMap(
  prisma: Pick<PrismaService, 'settings'>,
): Promise<Record<string, unknown>> {
  const settings = await prisma.settings.findUnique({
    where: { id: 1 },
    select: { userNotifications: true },
  });
  const raw = settings?.userNotifications;
  return raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}
