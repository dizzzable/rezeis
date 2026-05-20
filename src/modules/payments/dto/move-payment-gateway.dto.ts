import { IsEnum } from 'class-validator';

export enum PaymentGatewayMoveDirection {
  UP = 'up',
  DOWN = 'down',
}

export class MovePaymentGatewayDto {
  @IsEnum(PaymentGatewayMoveDirection)
  public direction!: PaymentGatewayMoveDirection;
}
