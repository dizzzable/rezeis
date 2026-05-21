/**
 * Stable, transport-agnostic exception emitted by `EmailService` when an outbound
 * delivery attempt cannot be completed. Callers may inspect `deliveryState` to
 * decide whether to revoke the issued challenge or retry later.
 *
 * The state vocabulary intentionally distinguishes between
 *   - `definitely-not-delivered` — the message is certainly NOT in any provider
 *     queue. Issuing systems can safely revoke the challenge.
 *   - `possibly-delivered` — the transport might already have queued or sent
 *     the message and the caller MUST NOT revoke the challenge to avoid
 *     accidentally invalidating a code the recipient has already received.
 */
export type EmailDeliveryState = 'definitely-not-delivered' | 'possibly-delivered';

export class EmailDeliveryException extends Error {
  public readonly deliveryState: EmailDeliveryState;
  public readonly cause?: unknown;

  public constructor(
    message: string,
    deliveryState: EmailDeliveryState,
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.name = 'EmailDeliveryException';
    this.deliveryState = deliveryState;
    this.cause = options?.cause;
  }
}
