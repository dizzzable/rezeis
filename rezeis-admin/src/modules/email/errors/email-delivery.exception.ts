import { ServiceUnavailableException } from '@nestjs/common';

export type EmailDeliveryState = 'definitely-not-delivered' | 'delivery-status-uncertain';

export class EmailDeliveryException extends ServiceUnavailableException {
  public constructor(public readonly deliveryState: EmailDeliveryState) {
    super('failed to deliver linked-account verification email');
  }
}

export class InvalidRecipientEmailDeliveryException extends EmailDeliveryException {
  public constructor() {
    super('definitely-not-delivered');
  }
}
