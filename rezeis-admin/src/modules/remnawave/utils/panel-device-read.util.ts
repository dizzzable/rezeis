import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';

import {
  describeStrictOutcome,
  RemnawaveStrictOutcome,
} from '../interfaces/remnawave-strict-outcome.interface';

/**
 * The ONE place that decides what a device-list reader is told when the panel
 * could not give us a list.
 *
 * Both audiences that render a device list — the customer cabinet (via the
 * reiwa BFF) and the operator's admin panel — used to receive
 * `{ devices: [], total: 0 }` on a panel outage, byte-identical to a genuinely
 * empty list. A customer whose slots were full read that as "all slots free",
 * tried to bind another device, and the panel refused with nothing on our side
 * to explain it.
 *
 * The product decision, deliberately the SAME for both audiences: on a failed
 * read the request FAILS. Neither audience is handed a number, because any
 * number we could invent is a lie and any "0 + a flag" payload is one an
 * existing client silently renders as "no devices" — which is the bug. What
 * differs is only how each client presents the failure:
 *
 *   • customer cabinet — reiwa gets a 5xx with an explicit message instead of
 *     an empty list, so the cabinet shows "device list unavailable, try again"
 *     rather than a device count the customer would act on. Retrying is the
 *     right advice, and the count they were about to trust never appears.
 *   • admin panel — `DevicesSection` in `web/.../user-detail-panel.tsx`
 *     already branches on the query's `isError` and renders
 *     `devicesList.loadError`; before this change it fell through to
 *     `devicesList.empty`. So the operator now reads "could not load" where
 *     they used to read "no devices", with no web change required.
 *
 * Status choice:
 *
 *   • `unavailable` → 503. Transient (network, timeout, 5xx, 429): retrying is
 *     the correct next move.
 *   • `notFound`    → 503 as well. Per the adapter's status taxonomy a bare
 *     404 is only a "the thing is gone" signal for the callers that own that
 *     semantic (profile PATCH/DELETE); a device list does not, and a 404 from
 *     a reverse proxy with no healthy backend IS an outage. Rendering it as an
 *     empty list is exactly the swallow this function exists to end.
 *   • `unsupported` / `invalidContract` → 502. The panel answered, but not in
 *     a way we can trust; retrying identical bytes cannot help, so it must not
 *     be dressed up as a retryable outage. Matches
 *     `RemnawaveUpstreamRejectionError`, which is already 502.
 *
 * The outcome kind travels in the message, so the failure is distinguishable
 * in the RESPONSE and not only in a log.
 */
export function requirePanelDeviceList<T>(outcome: RemnawaveStrictOutcome<T>): T {
  if (outcome.kind === 'ok') return outcome.value;

  const detail = describeStrictOutcome(outcome);
  if (outcome.kind === 'unavailable' || outcome.kind === 'notFound') {
    throw new ServiceUnavailableException(
      `Device list is temporarily unavailable: the Remnawave panel did not answer (${detail})`,
    );
  }
  throw new BadGatewayException(
    `Device list could not be read: the Remnawave panel answered unusably (${detail})`,
  );
}
