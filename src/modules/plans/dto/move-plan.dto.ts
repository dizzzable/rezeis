import { IsEnum } from 'class-validator';

export enum PlanMoveDirection {
  UP = 'up',
  DOWN = 'down',
}

export class MovePlanDto {
  @IsEnum(PlanMoveDirection)
  public direction!: PlanMoveDirection;
}
