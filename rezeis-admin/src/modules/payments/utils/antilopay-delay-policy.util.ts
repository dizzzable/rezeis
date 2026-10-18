import { PaymentGatewayType } from '@prisma/client';

import { CABINET_CAPABILITY, type CabinetView } from '../../reiwa-peers/cabinet-capabilities';
import {
  type AntilopayAutopayMethod,
  type AntilopayDelay,
  makeAntilopayDelay,
  readAntilopayDelay,
} from './antilopay-recurrent.util';
import { isAutopayApproved } from './gateway-autopay.util';

/**
 * Whether an Antilopay SBP sign-up is made with «Отсрочка первого списания по
 * СБП», and the delay the payer is told about.
 *
 * It is decided when the draft is made (the terms carry it, so the payment form
 * and the wire payload say what the payer agreed to), and offered only when ALL
 * hold:
 *
 *  - the payer chose SBP. A card has no delay: Antilopay's `PAYMENT_TEMPLATE`
 *    has none, and its first payment is charged on the form;
 *  - the operator approved SBP and set a delay (`readAntilopayDelay`);
 *  - the cabinet that asks can show it (`web.autopay-first-charge-delay`), and
 *    says the plan comes with the first charge
 *    (`web.autopay-delay-access-after-charge`, 18.10.2026: «без доступа на
 *    время отсрочки»). An older cabinet writes «спишется сразу» over the
 *    consent, or promises access for the delay at once; a delay sent for it
 *    would be a promise the panel does not keep. It does what it always did:
 *    the first charge at activation;
 *  - the customer has not used the delay before. It is given once.
 *
 * The one place the capability is read for this behaviour: the registry names
 * this file as the gate, and `test/cabinet-capabilities.registry.spec.ts` holds
 * it to that.
 */
export function decideAntilopayDelay(input: {
  readonly settings: Record<string, unknown>;
  readonly method: AntilopayAutopayMethod | undefined;
  /** The cabinet asking; absent for a caller that is not one. */
  readonly audience: CabinetView | undefined;
  /** The customer has used the delay, or holds one that is being granted. */
  readonly alreadyUsed: boolean;
}): AntilopayDelay | null {
  if (input.method !== 'SBP') return null;
  if (!isAutopayApproved(PaymentGatewayType.ANTILOPAY, input.settings, 'SBP')) return null;
  if (input.audience === undefined || !input.audience.can(CABINET_CAPABILITY.autopayFirstChargeDelay)) return null;
  if (!input.audience.can(CABINET_CAPABILITY.autopayDelayAccessAfterCharge)) return null;
  if (input.alreadyUsed) return null;
  return readAntilopayDelay(input.settings);
}

/** What the checkout request says the payer was shown: both fields, or neither. */
export type ShownDelay =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'SHOWN'; readonly delay: AntilopayDelay }
  | { readonly kind: 'MALFORMED' };

/**
 * The delay the cabinet reports having shown (`autopayDelayCount`,
 * `autopayDelayUnit`). Only a cabinet that declares the capability sends it, and
 * only when the panel's own list of gateways offered a delay. One field without
 * the other, or a delay that is not one, is MALFORMED and refused: the payer
 * was shown something the panel cannot read.
 */
export function readShownDelay(input: {
  readonly autopayDelayCount?: unknown;
  readonly autopayDelayUnit?: unknown;
}): ShownDelay {
  const hasCount = input.autopayDelayCount !== undefined && input.autopayDelayCount !== null;
  const hasUnit = input.autopayDelayUnit !== undefined && input.autopayDelayUnit !== null;
  if (!hasCount && !hasUnit) return { kind: 'NONE' };
  const delay = hasCount && hasUnit ? makeAntilopayDelay(input.autopayDelayCount, input.autopayDelayUnit) : null;
  return delay === null ? { kind: 'MALFORMED' } : { kind: 'SHOWN', delay };
}

/** Whether two delays are the same promise: the same number of the same unit. */
export function sameDelay(left: AntilopayDelay | null, right: AntilopayDelay | null): boolean {
  if (left === null || right === null) return left === right;
  return left.count === right.count && left.unit === right.unit;
}

/**
 * The delay a checkout is made with, once the payer's consent and the panel's own
 * decision are put side by side. The payer agreed to what they were SHOWN, so:
 *
 *  - nothing shown: no delay, whatever the panel would offer today — the payer
 *    was told the charge is made now (a cabinet that declares the capability but
 *    could not offer the delay, or an older one);
 *  - a delay shown that the panel would not give now (the operator changed or
 *    removed it, the customer used it in another tab): REFUSED. The payer is not
 *    charged now after being told they would not be, and not given a different
 *    delay either. The cabinet reloads its list and asks again;
 *  - a delay shown that is the one decided: that one.
 */
export type DelayVerdict =
  | { readonly kind: 'APPLY'; readonly delay: AntilopayDelay | null }
  | { readonly kind: 'REFUSE' };

export function settleDelayWithConsent(shown: ShownDelay, decided: AntilopayDelay | null): DelayVerdict {
  if (shown.kind === 'MALFORMED') return { kind: 'REFUSE' };
  if (shown.kind === 'NONE') return { kind: 'APPLY', delay: null };
  return sameDelay(shown.delay, decided) ? { kind: 'APPLY', delay: decided } : { kind: 'REFUSE' };
}
