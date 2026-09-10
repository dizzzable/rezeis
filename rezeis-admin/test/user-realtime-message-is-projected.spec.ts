import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserRealtimeService } from '../src/modules/realtime/services/user-realtime.service';
import type { UserRealtimeEventInterface } from '../src/modules/realtime/interfaces/user-realtime-event.interface';

/**
 * THE SENTENCE A CUSTOMER ACTUALLY RECEIVES.
 *
 * `user-realtime-message-safety.spec.ts` beside this file checks the TABLE —
 * that every projection carries a message of its own and that none of them
 * reads like an operator wrote it. Every one of those cases can be green while
 * the one line that applies the table is wrong, and it was: replacing
 * `message: projection.message ?? event.message` with `message: event.message`
 * left the whole panel suite passing.
 *
 * What comes through that hole is the operator's own sentence, which for this
 * event is `Remnawave profile created: <the operator's prefix><the customer's
 * login><suffix>` — the provider's profile naming scheme, on the customer's
 * screen, in a language they did not choose. It is the exact leak the table was
 * built to close, one layer below where the table lives.
 *
 * `fanOut` is private and is normally driven by a hook installed on the admin
 * gateway. Reached here through a cast rather than by standing up the gateway:
 * what is under test is one expression, and everything needed to reach it
 * honestly would be scaffolding around that expression rather than a check of
 * it.
 */

type FanOut = (event: {
  type: string;
  message: string;
  severity?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}) => void;

function buildService(): {
  readonly received: UserRealtimeEventInterface[];
  readonly fanOut: FanOut;
} {
  const service = new UserRealtimeService({
    // The hook is installed lazily against the admin gateway; there is none
    // here, and `subscribe` tolerates that.
    get: () => {
      throw new Error('no admin gateway in this harness');
    },
  } as never);

  const received: UserRealtimeEventInterface[] = [];
  service.subscribe({
    userId: 'user-1',
    telegramId: null,
    handler: (event) => received.push(event),
  });

  const fanOut = (service as unknown as { fanOut: FanOut }).fanOut.bind(service);
  return { received, fanOut };
}

describe('what a customer is told when an event reaches them', () => {
  it('is the projection sentence, never the operator log line', () => {
    const { received, fanOut } = buildService();

    fanOut({
      type: 'subscription.created',
      // Verbatim from `profile-sync.processor.ts`.
      message: 'Remnawave profile created: rz_ivanov_vpn',
      severity: 'INFO',
      metadata: { userId: 'user-1', subscriptionId: 'sub-1', planName: 'Pro' },
      timestamp: new Date().toISOString(),
    });

    assert.equal(received.length, 1, 'the subscriber was not reached at all');
    assert.equal(received[0].message, 'Your subscription is ready');
    assert.doesNotMatch(
      received[0].message,
      /remnawave|profile|rz_/i,
      'the operator sentence reached a customer',
    );
  });

  it('says the same thing however loud the operator log line was', () => {
    // Anti-coincidence anchor: a hard-coded string in the service would satisfy
    // the case above. Two different operator sentences for two different types
    // must produce the two different projection sentences.
    const { received, fanOut } = buildService();

    fanOut({
      type: 'payment.failed',
      message: 'Payment FAILED for a BLOCKED customer, enqueue refused',
      severity: 'ERROR',
      metadata: { userId: 'user-1', paymentId: 'pay-1' },
      timestamp: new Date().toISOString(),
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].message, 'The payment did not go through');
  });

  it('never hands over an event no projection claims', () => {
    // The other half of the same guarantee: a type outside the whitelist has no
    // neutral sentence to substitute, so it must not be forwarded at all.
    const { received, fanOut } = buildService();

    fanOut({
      type: 'subscription.trial_granted',
      message: 'Trial subscription provisioned: rz_ivanov_vpn',
      severity: 'INFO',
      metadata: { userId: 'user-1' },
      timestamp: new Date().toISOString(),
    });

    assert.deepEqual(received, []);
  });
});
