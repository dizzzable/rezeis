import { Injectable, Logger } from '@nestjs/common';
import { BlockedIdentityKind, DeviceSignalKind } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { UserIpObservationService } from '../../device-intelligence/services/user-ip-observation.service';
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
/**
 * How many conversations from one machine, inside {@link REPEAT_WINDOW_DAYS},
 * stop looking like somebody with problems and start looking like somebody
 * with a point to make.
 *
 * Three. Two is a person whose first answer did not help; the third inside a
 * week is a pattern. It marks and never refuses, so being wrong about it costs
 * an operator one glance.
 */
const REPEAT_CONVERSATION_THRESHOLD = 3;

/**
 * The window the count is taken over.
 *
 * Bounded because an unbounded count eventually marks a customer who has had
 * three separate problems across two years — which describes a loyal customer,
 * not a pest.
 */
const REPEAT_WINDOW_DAYS = 7;

@Injectable()
export class GuestGateService {
  private readonly logger = new Logger(GuestGateService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly ipObservations: UserIpObservationService,
  ) {}

  public async evaluate(input: {
    readonly installId?: string | null;
    readonly deviceHash?: string | null;
    /** The visitor's address, as the edge saw it. */
    readonly clientIp?: string | null;
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
    if (signals.length === 0) return this.byAddress(input.clientIp);

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

    // ── The pest who never had an account ────────────────────────────────
    //
    // Everything above matches against a BLOCKED ACCOUNT, and somebody can
    // flood anonymous support without ever having registered — in which case
    // there is no account, no ban, and nothing for those checks to find.
    //
    // What gives them away is the only thing they cannot avoid while using the
    // channel: coming back. Three conversations from one machine inside a week
    // is not how somebody with a problem behaves; it is how somebody with a
    // point to make behaves.
    //
    // Time-bounded on purpose. An unbounded count would eventually mark a
    // customer who has had three separate problems over two years, which is a
    // loyal customer rather than a pest.
    const since = new Date(Date.now() - REPEAT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const priorConversations = await this.prismaService.supportGuest.count({
      where: {
        createdAt: { gte: since },
        OR: [{ installId: { in: signals } }, { deviceHash: { in: signals } }],
      },
    });
    if (priorConversations >= REPEAT_CONVERSATION_THRESHOLD) {
      return {
        kind: 'allow',
        flaggedReason:
          `${priorConversations} conversations from this device in the last ` +
          `${REPEAT_WINDOW_DAYS} days`,
      };
    }

    // Nothing on the device. The address is the other half — and on this
    // product it is the stronger half, because it comes from the VPN
    // connection itself rather than from a browser that can decline to answer.
    return this.byAddress(input.clientIp);
  }

  /**
   * The address half of the same question.
   *
   * Separate and last because it says LESS: a device is a machine, an address
   * is a place, and households, offices and shared connections are ordinary.
   * `UserIpObservationService` already refuses our own exit nodes and carrier
   * NAT, so what survives is worth showing an operator — but it still marks and
   * never refuses.
   */
  private async byAddress(clientIp: string | null | undefined): Promise<GuestGateVerdict> {
    if (typeof clientIp !== 'string' || clientIp.trim().length === 0) {
      return { kind: 'allow', flaggedReason: null };
    }
    const matches = await this.ipObservations.blockedMatches(clientIp);
    if (matches.length === 0) return { kind: 'allow', flaggedReason: null };
    return {
      kind: 'allow',
      flaggedReason:
        `address was seen on ${matches.length} blocked account(s)` +
        // The hit count is what separates a home connection from somewhere
        // passed through once, and it is the first thing an operator weighs.
        ` (strongest: ${matches[0].hits} sighting(s))`,
    };
  }
}
