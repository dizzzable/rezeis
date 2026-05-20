/**
 * Wire shape of a single webhook delivery job. Kept minimal — the
 * processor re-reads the delivery row from DB to get the full payload
 * (avoids large payloads bouncing through Redis).
 */
export interface WebhookDeliveryJobInterface {
  readonly deliveryId: string;
}
