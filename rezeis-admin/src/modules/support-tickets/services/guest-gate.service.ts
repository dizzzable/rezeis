import { Injectable, Logger } from '@nestjs/common';
import { BlockedIdentityKind, DeviceSignalKind } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { normaliseDeviceSignal } from '../../device-intelligence/utils/device-signal.util';

/** What the gate decided about one attempt to open a guest conversation. */
export type GuestGateVerdict =
  /** Let it through. `flaggedReason` is non-null when it looked suspicious. */
  | { readonly kind: 'allow'; readonly flaggedReason: string | null }
  /** An operator silenced this device by hand. */
  | { readonly kind: 'silenced' };

/**
 * Who may open an anonymous support conversation, and which ones to mark.
 *
 * ── Two different answers, and the difference is the whole design ─────────
 *
 * MARK is automatic. A conversation opened from a device that belongs to a
 * blocked account is suspicious, and the operator should see that before
 * spending time on it.
 *
 * SILENCE is manual, always. It happens only when an operator has looked at
 * one of those marked conversations and put the fingerprint on the blocklist
 * themselves.
 *
 * They must not be the same thing, and the reason is the appeal. Guest support
 * is where somebody blocked BY MISTAKE writes to us — and where somebody an
 * automation rule blocked at three in the morning over a failed payment writes
 * too. If a device match refused, every ban would silently close the door
 * behind it and a wrong ban would be unappealable. That is a worse failure
 * than a noisy queue, because the noisy queue is visible and this would not be.
 *
 * ── Why `source` is what separates them ──────────────────────────────────
 *
 * `UserBlockService` already copies a blocked account's device fingerprints
 * into `blocked_identities` as `DEVICE_FP` rows with `source: 'cascade'`. If
 * the gate refused on any `DEVICE_FP` entry, every ban would silence support
 * automatically — precisely the behaviour the paragraph above rules out.
 *
 * So only `source: 'manual'` silences. A cascade row still MARKS, which is what
 * makes the operator's decision an informed one.
 */
@Injectable()
export class GuestGateService {
  private readonly logger = new Logger(GuestGateService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  public async evaluate(input: {
    readonly installId?: string | null;
    readonly deviceHash?: string | null;
  }): Promise<GuestGateVerdict> {
    // Normalised through the SAME function the device-observation writer uses,
    // so a value stored by one side is findable by the other. A signal that
    // fails validation is treated as absent rather than as a miss: it is a
    // malformed input, not evidence about anybody.
    const signals = [
      normaliseDeviceSignal(DeviceSignalKind.INSTALL_ID, input.installId),
      normaliseDeviceSignal(DeviceSignalKind.DEVICE_HASH, input.deviceHash),
    ]
      .filter((outcome) => outcome.ok)
      .map((outcome) => (outcome as { value: string }).value);
    if (signals.length === 0) return { kind: 'allow', flaggedReason: null };

    const entries = await this.prismaService.blockedIdentity.findMany({
      where: { kind: BlockedIdentityKind.DEVICE_FP, value: { in: signals } },
      select: { source: true, reason: true },
    });

    // Manual first: an operator's explicit decision outranks the automatic
    // mark, and a device carrying both rows is one the operator already judged.
    if (entries.some((entry) => entry.source === 'manual')) {
      return { kind: 'silenced' };
    }
    if (entries.length > 0) {
      return {
        kind: 'allow',
        flaggedReason:
          'device is on the blocklist from a blocked account (captured automatically)',
      };
    }

    // Nothing on the blocklist. The device may still be one a blocked account
    // has used — the observation table outlives nothing, but the blocklist copy
    // is only written when somebody is actually blocked, and an account can be
    // blocked without its devices ever having been readable.
    const observed = await this.prismaService.deviceObservation.findFirst({
      where: { value: { in: signals }, user: { isBlocked: true } },
      select: { userId: true },
    });
    if (observed !== null) {
      return {
        kind: 'allow',
        flaggedReason: 'device was seen on a blocked account',
      };
    }
    return { kind: 'allow', flaggedReason: null };
  }
}
